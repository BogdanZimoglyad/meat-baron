/* Перевірка підсумків /week і /month на справжньому коді: вирізаємо
   statsRange, cmp і statsText із server.js і рахуємо на підставлених
   замовленнях. Запуск: node tools/stats-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CAT = require(path.join(__dirname, '..', 'catalog.js'));

const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли: ' + re); process.exit(1) } return m[0] };
const code = [
  cut(/const kyivHour = ms =>[\s\S]*?hour12: false \}\)\);/),
  cut(/function statsRange\(shopList, from, to\) \{[\s\S]*?\n\}/),
  cut(/const cmp = \(a, b\) => \{[\s\S]*?\n\};/),
  cut(/function statsText\(shopList, days, title\) \{[\s\S]*?\n\}/)
].join('\n');

const DAY = 24 * 3600e3, MIN = 60000;
const byId = new Map(CAT.ITEMS.map(i => [i.id, i]));
const id = name => CAT.ITEMS.find(i => i.name === name).id;
const env = {
  byId,
  nameOf: CAT.nameOf,          // підпис позиції: «Люля кебаб курячий» замість двох однакових
  SHOPS: ['Свободи 52', 'Шевченка 142а'],
  CANCELED: 'canceled',
  esc: s => String(s),
  money: n => CAT.kop(n).toFixed(2).replace(/\.00$/, '') + ' ₴',
  wLabel: g => (g >= 1000 ? (g / 1000).toFixed(g % 100 ? 2 : g % 1000 ? 1 : 0) + ' кг' : g + ' г'),
  db: null
};
const build = orders => {
  env.db = { orders };
  const fn = new Function(...Object.keys(env), `${code}; return { statsRange, statsText }`);
  return fn(...Object.values(env));
};

const ord = (o = {}) => ({
  shop: 0, status: 'done', total: 500, createdAt: Date.now() - 2 * DAY,
  slotAt: 0, mode: 'pickup', fry: true, fg: 1000,
  lines: [{ id: id('Ошийок'), name: 'Ошийок' }], ...o
});

const t = [];
const has = (text, part) => text.includes(part);

// 1. порожньо
let s = build({});
t.push(['порожній тиждень — так і кажемо', has(s.statsText([0], 7), 'Замовлень із сайту не було')]);

// 2. рахунок і скасовані
s = build({
  1: ord({ total: 400 }), 2: ord({ total: 600 }),
  3: ord({ total: 900, status: 'canceled' })
});
let w = s.statsText([0], 7);
t.push(['скасоване не в сумі', has(w, 'Замовлень: <b>2</b>') && has(w, 'Сума: <b>1000 ₴</b>')]);
t.push(['середній чек', has(w, 'Середній чек: <b>500 ₴</b>')]);
t.push(['скасовані окремим рядком', has(w, 'Скасовано: 1')]);

// 3. чужа точка не рахується
s = build({ 1: ord(), 2: ord({ shop: 1, total: 1000 }) });
t.push(['лічимо лише свою точку', has(s.statsText([0], 7), 'Замовлень: <b>1</b>')]);
t.push(['разом по мережі — обидві', has(s.statsText([0, 1], 7, 'Разом'), 'Замовлень: <b>2</b>')]);

// 4. порівняння з попереднім періодом
s = build({
  1: ord({ createdAt: Date.now() - 2 * DAY, total: 1000 }),
  2: ord({ createdAt: Date.now() - 10 * DAY, total: 500 })
});
t.push(['зростання показує ▲', has(s.statsText([0], 7), '▲ +100%')]);

// 5. топ позицій і години видачі
const slot = (h) => { const d = new Date(Date.now() - DAY); d.setHours(h, 0, 0, 0); return d.getTime() };
s = build({
  1: ord({ lines: [{ id: id('Ошийок') }, { id: id('Сулугуні') }], slotAt: slot(18) }),
  2: ord({ lines: [{ id: id('Ошийок') }], slotAt: slot(18) }),
  3: ord({ lines: [{ id: id('Мʼякоть') }], slotAt: slot(12) })
});
w = s.statsText([0], 7);
t.push(['топ очолює найчастіше замовлюване', has(w, '1. Ошийок — 2')]);
t.push(['години видачі рахуються', /1[78]:00 — 2/.test(w)]);

// 6. старі номери позицій не ламають топ
s = build({ 1: ord({ lines: [{ id: 'p0' }, { id: id('Ошийок') }] }) });
t.push(['позицій поза прайсом у топі немає', !has(s.statsText([0], 7), 'p0')]);

let bad = 0;
for (const [name, ok] of t) { console.log((ok ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!ok) bad++ }
console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad ? 1 : 0);
