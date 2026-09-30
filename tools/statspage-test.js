/* Перевірка сторінки статистики власника на справжньому коді: вирізаємо
   з server.js statsRange і statsPage і рахуємо на підставлених
   замовленнях і відвідуваннях. Головне — щоб сторінка й /week рахували
   однаково: вона бере підсумки з того самого statsRange.
   Запуск: node tools/statspage-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const CAT = require(path.join(__dirname, '..', 'catalog.js'));

const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли: ' + re); process.exit(1) } return m[0] };
const code = [
  cut(/const kyivHour = [\s\S]*?\);\n/),
  cut(/function statsRange\(shopList, from, to\) \{[\s\S]*?\n\}/),
  cut(/function kyivMs\(day, h, m\) \{[\s\S]*?\n\}/),
  cut(/const wdayOf = [^\n]*/),
  cut(/function statsPage\(shopList, days\) \{[\s\S]*?\n\}/)
].join('\n');

const HOUR = 3600e3, DAY = 24 * HOUR;
const kyivDate = (ts = Date.now()) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
const byId = new Map(CAT.ITEMS.map(i => [i.id, i]));
const item = n => CAT.ITEMS.find(i => i.name === n);
const db = { orders: {}, hits: {} };
const env = {
  db, HOUR, kyivDate, CANCELED: 'canceled', kop: CAT.kop, lineTitle: CAT.lineTitle, byId,
  adjustmentsOf: o => (Array.isArray(o.adjust) ? o.adjust : [])
};
const api = new Function(...Object.keys(env), `${code}; return { statsRange, statsPage }`)(...Object.values(env));

const now = Date.now();
let no = 1000;
const line = (name, g, sum) => { const it = item(name); return { id: it.id, name: it.name, grp: it.grp, unit: it.unit, g, sum } };
const add = (ago, o) => { const x = { no: ++no, shop: 0, status: 'done', mode: 'pickup', pay: 'cash', fry: true, fg: 1000,
  createdAt: now - ago, slotAt: now - ago + 2 * HOUR, telKey: '671111111', total: 500, lines: [line('Ошийок', 1000, 366.9)], ...o };
  db.orders[x.no] = x; return x };

add(1 * HOUR, { total: 800, telKey: '671111111' });
add(2 * DAY, { total: 400, telKey: '672222222', mode: 'delivery', pay: 'card' });
add(3 * DAY, { total: 600, telKey: '673333333', lines: [line('Ошийок', 1500, 550), line('Лаваш тонкий', 2, 70)] });
add(4 * DAY, { status: 'canceled', total: 900, telKey: '674444444',
  adjust: [{ kind: 'cancel', note: 'клієнт не відповідає', by: 'панель', at: now - 4 * DAY + HOUR }] });
add(40 * DAY, { total: 999, telKey: '672222222' });                        // давнє — поза 30 днями, але робить 672… «поверненим»
db.hits[kyivDate(now)] = { visit: 50, cart: 12, checkout: 6 };
db.hits[kyivDate(now - DAY)] = { visit: 30, cart: 5 };

const s = api.statsPage([0], 30);
const t = [];
const ok = (n, c) => t.push([n, c]);

ok('30 днів — 30 стовпчиків', s.perDay.length === 30 && s.days === 30);
ok('замовлень 3, скасовано 1 (давнє не в рахунку)', s.cur.n === 3 && s.cur.canceled === 1);
ok('виручка без скасованих: 1800', s.cur.sum === 1800);
ok('середній чек 600', Math.round(s.cur.avg) === 600);
ok('підсумки ті самі, що в statsRange (/week)',
  JSON.stringify(api.statsRange([0], new Date(s.perDay[0].day + 'T00:00:00+03:00').getTime(), now).n) === JSON.stringify(s.cur.n));
ok('самовивіз 2, доставка 1', s.cur.pickup === 2 && s.cur.delivery === 1);
ok('оплата: готівка 2, картка 1', s.pay.cash === 2 && s.pay.card === 1);
const osh = s.top.find(x => x.name === 'Ошийок');
ok('ошийок: у 3 замовленнях, 3.5 кг, 1283.80 ₴', osh && osh.orders === 3 && osh.qty === 3500 && osh.sum === 1283.8);
ok('лаваш у топі штуками', s.top.some(x => x.name.startsWith('Лаваш') && x.qty === 2 && x.unit !== 'вага'));
ok('клієнтів 3: нових 2, повернувся 1', s.people.total === 3 && s.people.fresh === 2 && s.people.again === 1);
ok('воронка: 80 заходів, 17 кошиків, 6 оформлень, 4 замовлення', s.funnel.visit === 80 && s.funnel.cart === 17
  && s.funnel.checkout === 6 && s.funnel.orders === 4);
ok('лічильник працює з першого дня з даними', s.hitsSince === kyivDate(now - DAY));
ok('скасування з причиною', s.cancels.length === 1 && s.cancels[0].why === 'клієнт не відповідає');
ok('сьогоднішній день останній у ряду', s.perDay[29].day === kyivDate(now) && s.perDay[29].visit === 50);
ok('7 днів — 7 стовпчиків', api.statsPage([0], 7).perDay.length === 7);

let bad = 0;
for (const [n, good] of t) { console.log((good ? '  ok  ' : 'ПАДАЄ') + ' · ' + n); if (!good) bad++ }
console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad ? 1 : 0);
