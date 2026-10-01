/* Наскрізна перевірка сервера: піднімаємо справжній server.js із
   підставним Telegram-ботом і тимчасовою базою та ходимо по його
   адресах так, як ходять сайт, панель і сторінка статистики. Ловить те,
   чого не видно з окремих функцій: маршрути, доступи, поля замовлення.
   Запуск: npm test   (нічого в інтернет не шле) */
const path = require('path');
const report = require('../report.js');
const { call, say, reply, sent, cleanup } = await require('./harness.js')({ port: 38777 });
const t = [];
const ok = (n, c) => t.push([n, !!c]);
const CAT = require(path.join(__dirname, '..', '..', 'catalog.js'));
const osh = CAT.ITEMS.find(i => i.name === 'Лаваш тонкий') || CAT.ITEMS[0];

{
  const IOS = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' };
  const WIN = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' };

  /* 1. Лічильник відвідувань */
  let r = await call('POST', '/api/hit', { e: 'visit', s: 'abcdefgh1', src: 'ig' }, IOS);
  await call('POST', '/api/hit', { e: 'visit', s: 'abcdefgh1' }, IOS);            // той самий візит — не вдруге
  await call('POST', '/api/hit', { e: 'visit', s: 'zzzzzzzz2', src: 'nonsense' }, WIN);
  await call('POST', '/api/hit', { e: 'cart', s: 'abcdefgh1' }, IOS);
  ok('лічильник приймає подію', r.status === 200);
  ok('лічильник відкидає сміття', (await call('POST', '/api/hit', { e: 'hack', s: 'abcdefgh1' })).status === 400);

  /* 2. Замовлення з сайту: пристрій, «з іконки», без входу */
  const slotAt = Date.now() + 3 * 3600e3;
  const order = (extra = {}) => ({ shop: 0, shopName: CAT.SHOPS[0][0], mode: 'pickup', fry: false, fg: 0, pay: 'cash', nm: 'Тест', tel: '+380671234567',
    note: '', when: 'Сьогодні', slotAt, lines: [{ id: osh.id, name: osh.name, grp: osh.grp, unit: osh.unit, g: 1, sum: osh.price }], total: osh.price, ...extra });
  r = await call('POST', '/api/order', order({ app: true, src: 'ig' }), IOS);
  ok('замовлення прийнято', r.status === 200 && r.d.no > 0);
  const no1 = r.d.no;
  r = await call('POST', '/api/order', order({ note: 'тест, не готувати', tel: '+380671234568' }), WIN);
  const noTest = r.d.no;
  ok('друге (тестове) прийнято', r.status === 200);
  ok('картка пішла в чат точки', sent.some(x => x.chatId === -100 && /№/.test(x.text)));

  /* 3. Статистика: без ключа — ні; /stats у групі — ні; у особистих власника — посилання */
  ok('статистика без ключа — 401', (await call('GET', '/api/stats')).status === 401);
  sent.length = 0;
  say(-100, 777, '/stats', 'group');
  ok('/stats у групі — відмова', sent.some(x => /лише для власника/.test(x.text)));
  sent.length = 0;
  say(555, 555, '/stats');
  ok('/stats від чужого — відмова', sent.some(x => /лише для власника/.test(x.text)));
  sent.length = 0;
  say(777, 777, '/stats');
  const code = ((sent[0] || {}).text || '').match(/stats\.html#([0-9a-f]+)/);
  ok('/stats у власника — разове посилання', !!code);
  r = await call('POST', '/api/stats/claim', { code: code && code[1] });
  const H = { Authorization: 'Bearer ' + r.d.token };
  ok('код міняється на ключ', r.status === 200 && !!r.d.token);
  ok('код одноразовий', (await call('POST', '/api/stats/claim', { code: code && code[1] })).status === 403);

  r = await call('GET', '/api/stats?days=1', null, H);
  const s = r.d;
  ok('статистика з ключем — 200', r.status === 200 && s.ok);
  ok('тестове не в цифрах, але в списку', s.cur.n === 1 && s.tests === 1 && s.orders.length === 2 && s.orders.find(o => o.no === noTest).test);
  ok('пристрій і «з іконки» записані', s.orders.find(o => o.no === no1).dev === 'ios' && s.orders.find(o => o.no === no1).app === true);
  ok('заходи по пристроях: iPhone 1, ПК 1', s.devices.ios.visits === 1 && s.devices.pc.visits === 1 && s.funnel.visit === 2 && s.funnel.cart === 1);
  ok('звідки прийшли: Instagram — 1 захід і 1 замовлення, сміттєва мітка не рахується', s.sources.ig && s.sources.ig.visits === 1 && s.sources.ig.orders === 1
    && !s.sources.nonsense && s.shopsAll.length === CAT.SHOPS_ALL.length);
  ok('замовлення без входу — «без входу»', s.orders.find(o => o.no === no1).auth === false && s.tg.guest === 1);
  /* день видачі беремо з самого замовлення: увечері slotAt + 3 год — це вже завтра */
  const slotDay = new Date(s.orders.find(o => o.no === no1).slotAt).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  ok('за днем видачі — те саме замовлення', (await call('GET', `/api/stats?from=${slotDay}&to=${slotDay}&by=slot`, null, H)).d.cur.n === 1);

  /* 3б. Цифри каси: /kassa питає в чаті точки, відповідь іде в статистику */
  sent.length = 0;
  say(-100, 1, '/kassa', 'group');
  await new Promise(r => setTimeout(r, 50));
  const q = sent.find(x => /Телефонні замовлення за/.test(x.text));
  ok('/kassa питає в чаті точки', q && q.chatId === -100);
  sent.length = 0;
  await reply(-100, q, 'багато');
  ok('незрозуміла відповідь — пояснення і питання ще раз', sent.some(x => /Не вдалося розібрати/.test(x.text)) && sent.some(x => /Телефонні замовлення за/.test(x.text)));
  sent.length = 0;
  await reply(-100, q, '9 8100,50');
  ok('відповідь записана', sent.some(x => /Записано за .*телефоном 9 на 8100\.50 ₴/.test(x.text)));
  r = await call('GET', '/api/stats?days=1', null, H);
  ok('статистика: сайт проти телефону', r.d.kassa.days === 1 && r.d.kassa.n === 9 && r.d.kassa.sum === 8100.5 && r.d.kassa.siteN === 1);

  /* 4. /stats-off відкликає */
  say(777, 777, '/stats-off');
  ok('після /stats-off ключ не діє', (await call('GET', '/api/stats', null, H)).status === 401);

  /* 5. /panel і /panel-off: відкликання не видає нового посилання */
  sent.length = 0;
  say(-100, 1, '/panel-off', 'group');
  ok('/panel-off не видає посилання на панель', !sent.some(x => /op\.html#/.test(x.text)));
  sent.length = 0;
  say(-100, 1, '/panel', 'group');
  ok('/panel видає посилання', sent.some(x => /op\.html#/.test(x.text)));

  /* 6. Підсумок дня — без тестових */
  sent.length = 0;
  say(-100, 1, '/day', 'group');
  const day = (sent.find(x => /Підсумок дня|не було/.test(x.text)) || {}).text || '';
  ok('/day — тестове не враховано', /Замовлень: <b>1<\/b>/.test(day));

  cleanup();
  report(t);
}
