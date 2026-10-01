/* Перевірка підсумків /week і /month на справжньому коді: вирізаємо
   statsRange, cmp і statsText із server.js і рахуємо на підставлених
   замовленнях. Запуск: npm test */
const fs = require('fs');
const report = require('../report.js');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const CAT = require(path.join(__dirname, '..', '..', 'catalog.js'));

const cut = re => { const m = src.match(re); if (!m) { throw new Error('не знайшли: ' + re) } return m[0] };
const code = [
  cut(/const kyivHour = ms =>[\s\S]*?hour12: false \}\)\);/),
  cut(/const kyivDate = \(ts = Date\.now\(\)\) =>[\s\S]*?const futureDay = o => [^\n]*/),
  cut(/function dayStats\(shop, day\) \{[\s\S]*?\n\}/),
  cut(/function dayText\(shop, day\) \{[\s\S]*?\n\}/),
  cut(/const TEST_RE = [^\n]*/),
  cut(/const isTestOrder = [^\n]*/),
  cut(/function statsRange\([^)]*\) \{[\s\S]*?\n\}/),
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
  FINAL: new Set(['done','canceled']),
  esc: s => String(s),
  money: n => CAT.kop(n).toFixed(2).replace(/\.00$/, '') + ' ₴',
  wLabel: g => (g >= 1000 ? (g / 1000).toFixed(g % 100 ? 2 : g % 1000 ? 1 : 0) + ' кг' : g + ' г'),
  adjustmentsOf: o => (Array.isArray(o.adjust) ? o.adjust : []),
  db: null
};
const build = orders => {
  env.db = { orders };
  const fn = new Function(...Object.keys(env), `${code}; return { statsRange, statsText, dayStats, dayText }`);
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
/* година видачі — за Києвом, хоч би де стояв сервер (на GitHub і Railway — UTC) */
const kyivH = new Date(slot(18)).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false });
t.push(['години видачі рахуються', w.includes(kyivH + ':00 — 2')]);

// 6. старі номери позицій не ламають топ
s = build({ 1: ord({ lines: [{ id: 'p0' }, { id: id('Ошийок') }] }) });
t.push(['позицій поза прайсом у топі немає', !has(s.statsText([0], 7), 'p0')]);

// 7. підсумок дня: що зроблено сьогодні, а що лише чекає свого дня
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
const HOUR = 3600e3;
s = build({
  1: ord({ createdAt: Date.now(), status: 'done', slotAt: Date.now() - HOUR }),
  2: ord({ createdAt: Date.now(), status: 'cooking', slotAt: Date.now() + HOUR }),
  3: ord({ createdAt: Date.now(), status: 'accepted', slotAt: Date.now() + 2 * 24 * 3600e3 })
});
let dd = s.dayStats(0, today);
t.push(['«ще в роботі» — лише сьогоднішні', dd.open === 1]);
t.push(['замовлення на інший день лічимо окремо', dd.later === 1]);
let dt = s.dayText(0, today);
t.push(['у підсумку обидва рядки й різними словами',
  has(dt, 'Ще в роботі: 1') && has(dt, 'Чекають свого дня: 1')]);
s = build({ 1: ord({ createdAt: Date.now(), status: 'done', slotAt: Date.now() - HOUR }) });
t.push(['коли чекати нічого — рядка немає', !has(s.dayText(0, today), 'Чекають свого дня')]);

// 8. тестові (коментар «тест») — ні в підсумку дня, ні в /week
s = build({
  1: ord({ createdAt: Date.now(), status: 'done', total: 500 }),
  2: ord({ createdAt: Date.now(), status: 'done', total: 9000, note: 'тест' }),
  3: ord({ createdAt: Date.now(), status: 'done', total: 700, adjust: [{ kind: 'note', note: 'Тестове, не готувати' }] })
});
dd = s.dayStats(0, today);
t.push(['тестові не в підсумку дня', dd.all === 1 && dd.sum === 500]);
t.push(['тестові не в /week', s.statsRange([0], Date.now() - 7 * DAY, Date.now() + 1).n === 1]);

report(t);
