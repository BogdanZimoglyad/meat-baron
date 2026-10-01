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
  cut(/const DEVICES = [^\n]*/),
  cut(/const SOURCES = [^\n]*/),
  cut(/const TEST_RE = [^\n]*/),
  cut(/const isTestOrder = [^\n]*/),
  cut(/function statsRange\([^)]*\) \{[\s\S]*?\n\}/),
  cut(/function kyivMs\(day, h, m\) \{[\s\S]*?\n\}/),
  cut(/const wdayOf = [^\n]*/),
  cut(/const dayAdd = [^\n]*/),
  cut(/function statsPage\([^)]*\) \{[\s\S]*?\n\}/)
].join('\n');

const HOUR = 3600e3, DAY = 24 * HOUR;
const kyivDate = (ts = Date.now()) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
const byId = new Map(CAT.ITEMS.map(i => [i.id, i]));
const item = n => CAT.ITEMS.find(i => i.name === n);
const db = { orders: {}, hits: {} };
const env = {
  db, HOUR, kyivDate, SHOPS: CAT.SHOPS.map(x => x[0]), LABEL: { done: 'Видано', canceled: 'Скасовано' }, CANCELED: 'canceled', kop: CAT.kop, lineTitle: CAT.lineTitle, byId,
  adjustmentsOf: o => (Array.isArray(o.adjust) ? o.adjust : [])
};
const api = new Function(...Object.keys(env), `${code}; return { statsRange, statsPage, dayAdd }`)(...Object.values(env));

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
add(40 * DAY, { total: 999, telKey: '672222222' });
/* 671… увійшов через Telegram 10 днів тому; 673… замовив із позначкою входу */
db.users = { '671111111': { tgId: 1, tgSince: now - 10 * DAY }, '672222222': { tgId: 2, tgSince: now - 1 * HOUR } };
db.orders[1003].auth = true;
db.logins = { [kyivDate(now)]: { n: 3, fresh: 1 } };                        // давнє — поза 30 днями, але робить 672… «поверненим»
db.hits[kyivDate(now)] = { visit: 50, cart: 12, checkout: 6 };
db.hits[kyivDate(now - DAY)] = { visit: 30, cart: 5 };

const today = kyivDate(now);
const page = days => api.statsPage([0], api.dayAdd(today, 1 - days), today);
const s = page(30);
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
ok('7 днів — 7 стовпчиків', page(7).perDay.length === 7);
ok('Telegram: з входом 2 (увійшов раніше + позначка), без входу 1', s.tg.orders === 2 && s.tg.guest === 1);
ok('Telegram: 672… увійшов уже після замовлення — рахуємо як без входу', s.tg.guestSum === 400);
ok('Telegram: входів 3, уперше 1; нових акаунтів 2', s.tg.logins === 3 && s.tg.loginsFresh === 1 && s.tg.accounts === 2);
const one = api.statsPage([0], today, today);
ok('один день — список його замовлень', one.days === 1 && one.orders.length === 1
  && one.orders[0].total === 800 && one.orders[0].label === 'Видано');
ok('за період — список усіх його замовлень, від ранніх до пізніх', s.orders.length === 4
  && s.orders[0].at < s.orders[3].at);
const o4 = s.orders.find(o => o.status === 'canceled');
ok('у списку — усе про замовлення: склад, причина скасування', o4 && o4.lines.length === 1
  && o4.adj.some(a => a.kind === 'cancel' && a.note === 'клієнт не відповідає'));
const d3 = api.dayAdd(today, -3);
const three = api.statsPage([0], d3, d3);
ok('обраний день у минулому — лише його замовлення', three.cur.n === 1 && three.cur.sum === 600
  && three.from === d3 && three.to === d3);
ok('перший день із замовленнями — нижня межа календаря', s.first === kyivDate(now - 40 * DAY));
ok('dayAdd через кінець місяця', api.dayAdd('2026-09-30', 1) === '2026-10-01' && api.dayAdd('2026-03-01', -1) === '2026-02-28');

// ---------- за днем видачі: видно замовлення наперед ----------
const later = api.dayAdd(today, 3);
add(30 * 60000, { slotAt: new Date(later + 'T14:00:00+03:00').getTime(), total: 700, note: 'без цибулі' });
const byCreated = api.statsPage([0], later, later);
const bySlot = api.statsPage([0], later, later, 'slot');
ok('за днем замовлення майбутній день порожній', byCreated.cur.n === 0);
ok('за днем видачі — замовлення наперед на цей день', bySlot.cur.n === 1 && bySlot.cur.sum === 700 && bySlot.by === 'slot');
ok('коментар клієнта — у списку', bySlot.orders[0].note === 'без цибулі');
ok('сьогодні за днем видачі не бере того, що на післязавтра', api.statsPage([0], today, today, 'slot').orders.every(o => o.note !== 'без цибулі'));

// ---------- тестові не рахуємо ----------
const before = page(30);
add(20 * 60000, { total: 5000, note: 'Тест, не готувати' });
add(15 * 60000, { total: 3000, adjust: [{ kind: 'note', note: 'тестове замовлення', by: 'панель', at: now }] });
add(10 * 60000, { total: 200, note: 'протест проти цибулі' });
const after = page(30);
ok('тестові (коментар клієнта чи оператора) — не в цифрах', after.cur.sum === before.cur.sum + 200 && after.cur.n === before.cur.n + 1);
ok('«протест» — не тест', after.orders.some(o => o.note === 'протест проти цибулі' && !o.test));
ok('у списку тестові є, з позначкою, і пораховано скільки', after.tests === 2 && after.orders.filter(o => o.test).length === 2);
ok('воронка «замовили» — без тестових', after.funnel.orders === before.funnel.orders + 1);

// ---------- пристрої ----------
add(5 * 60000, { total: 300, dev: 'android' });
add(4 * 60000, { total: 900, dev: 'ios', app: true });
db.hits[kyivDate(now)].visit_ios = 10; db.hits[kyivDate(now)].visit_android = 4;
const dv = page(30);
ok('пристрої: iPhone 1 зам. із 10 заходів, Android 1 із 4', dv.devices.ios.orders === 1 && dv.devices.ios.visits === 10
  && dv.devices.android.orders === 1 && dv.devices.android.visits === 4 && dv.devices.ios.sum === 900);
ok('старі замовлення без позначки — «невідомо»', dv.devices.unknown.orders === dv.cur.n - 2);
ok('з іконки на екрані — пораховано', dv.appOrders === 1 && dv.orders.some(o => o.dev === 'ios' && o.app));

// ---------- звідки прийшли ----------
add(3 * 60000, { total: 500, src: 'ig' });
add(2 * 60000, { total: 700, src: 'qr3' });
db.hits[kyivDate(now)].src_ig = 7; db.hits[kyivDate(now)].src_tt = 2; db.hits[kyivDate(now)].src_hack = 99;
const sr = page(30);
ok('джерела: Instagram 1 зам. із 7 заходів, QR точки 3 — 1 зам., TikTok — лише заходи', sr.sources.ig.orders === 1 && sr.sources.ig.visits === 7
  && sr.sources.ig.sum === 500 && sr.sources.qr3.orders === 1 && sr.sources.tt.visits === 2 && !sr.sources.tt.orders);
ok('старі замовлення без мітки — «невідомо», чужі ключі не рахуються', sr.sources.unknown.orders === sr.cur.n - 2 && !sr.sources.hack);
ok('мітка є і в списку замовлень', sr.orders.some(o => o.src === 'qr3'));

// ---------- сайт проти телефону (цифри каси) ----------
const kz = page(30).kassa;
ok('каси не вносили — днів 0', kz.days === 0 && kz.n === 0);
db.kassa = { [kyivDate(now)]: { [CAT.SHOPS[0][0]]: { n: 20, sum: 15000 } }, '2020-01-01': { [CAT.SHOPS[0][0]]: { n: 99, sum: 1 } } };
const kk = page(30).kassa, cur = page(1).cur;
ok('частка сайту — лише за день, де внесли касу', kk.days === 1 && kk.n === 20 && kk.sum === 15000 && kk.of === 30);
ok('з сайту за той день — без тестових і скасованих', kk.siteN > 0 && kk.siteN <= cur.n + 5);
db.kassa[kyivDate(now)]['чужа точка'] = { n: 500, sum: 500000 };
ok('чужі точки не рахуються', page(30).kassa.n === 20);
delete db.kassa;

let bad = 0;
for (const [n, good] of t) { console.log((good ? '  ok  ' : 'ПАДАЄ') + ' · ' + n); if (!good) bad++ }
console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad ? 1 : 0);
