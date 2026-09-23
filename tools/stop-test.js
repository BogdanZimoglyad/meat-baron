/* Перевірка стоп-листа на справжньому коді: вирізаємо nextOpenMs,
   stopOf, isStopped і findItems із server.js. Запуск: node tools/stop-test.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const CAT = require(path.join(root, 'catalog.js'));

const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли ' + re); process.exit(1) } return m[0] };
const code = [
  cut(/function nextOpenMs\(\) \{[\s\S]*?\n\}/),
  cut(/function stopOf\(shop\) \{[\s\S]*?\n\}/),
  cut(/const isStopped = [^\n]*/),
  cut(/const foldName = [^\n]*/),
  cut(/const findItems = q => \{[\s\S]*?\n\};/)
].join('\n');

const mk = (db, hour) => {
  const env = {
    db, OPEN_HOUR: 8, CATALOG: CAT,
    kyivNow: () => { const d = new Date(); if (hour != null) d.setHours(hour, 30, 0, 0); return d }
  };
  const fn = new Function(...Object.keys(env), `${code}; return { nextOpenMs, stopOf, isStopped, findItems }`);
  return fn(...Object.values(env));
};

const HOUR = 3600e3;
const oshId = CAT.ITEMS.find(i => i.name === 'Ошийок').id;
const t = [];

// 1. свіжа відмітка діє, протухла — ні
let s = mk({ stop: { 0: { [oshId]: Date.now() + HOUR, 'iold': Date.now() - HOUR } } });
t.push(['свіжа відмітка діє', s.isStopped(0, oshId)]);
t.push(['протухла не діє', !s.isStopped(0, 'iold')]);
t.push(['протухлої немає в списку', Object.keys(s.stopOf(0)).length === 1]);

// 2. чужа точка не зачеплена
t.push(['сусідня точка торгує', !s.isStopped(1, oshId)]);

// 3. порожня база не падає
s = mk({});
t.push(['без бази — порожньо', Object.keys(s.stopOf(0)).length === 0 && !s.isStopped(0, oshId)]);

// 4. повернення о 8:00 — рахуємо, скільки лишилось чекати
/* Годинник підмінюємо лише в kyivNow, а Date.now() справжній, тож
   перевіряємо саме різницю: «скільки від цієї години до 8:00». */
const waitH = h => (mk({ stop: {} }, h).nextOpenMs() - Date.now()) / HOUR;
const near = (a, b) => Math.abs(a - b) < 0.1;
t.push(['о 14:30 чекати до завтра 8:00 (17.5 год)', near(waitH(14), 17.5)]);
t.push(['о 2:30 чекати до сьогодні 8:00 (5.5 год)', near(waitH(2), 5.5)]);
t.push(['о 7:30 чекати пів години', near(waitH(7), 0.5)]);
t.push(['о 8:30 — уже наступний ранок', near(waitH(8), 23.5)]);

// 5. пошук позиції
s = mk({ stop: {} });
t.push(['пошук за назвою', s.findItems('ошийок').some(i => i.id === oshId)]);
t.push(['пошук без апострофа', s.findItems('мякоть').some(i => i.name === 'Мʼякоть')]);
t.push(['пошук за групою', s.findItems('чевапчічі').length >= 3]);
t.push(['одна літера — нічого', s.findItems('о').length === 0]);
t.push(['дурниця — нічого', s.findItems('зззз').length === 0]);
t.push(['не більше восьми', s.findItems('а').length <= 8]);

let bad = 0;
for (const [name, ok] of t) { console.log((ok ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!ok) bad++ }
console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad ? 1 : 0);
