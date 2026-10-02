/* Шлях замовлення від покупця до видачі на справжньому server.js —
   так, як він іде щодня: вхід через Telegram → замовлення → картка в
   чаті точки → панель: статуси, сума, склад, час → сповіщення покупцю;
   доставка з вартістю й «отримав»; скасування з причиною; стоп-лист і
   мангал. Правила (applyStatus, applyAdjust, applyLine, applyTime,
   applyStock, applyGrill) тут кличуться так само, як із планшета.
   Запуск: npm test   (нічого в інтернет не шле) */
const path = require('path');
const report = require('../report.js');
const { call, say, press, contact, tick, sent, edits, cleanup } = await require('./harness.js')({ port: 38778 });
const CAT = require(path.join(__dirname, '..', '..', 'catalog.js'));

const t = [];
const ok = (n, c) => t.push([n, !!c]);
const item = name => CAT.ITEMS.find(i => i.name === name);
const lavash = item('Лаваш тонкий') || CAT.ITEMS.find(i => i.unit === 'шт');
const osh = item('Ошийок');
const CHAT = -100, CLIENT = 9001;
const toClient = re => sent.some(x => x.chatId === CLIENT && re.test(x.text));
/* Час видачі — за хвилину: так кнопки «Готується» й далі вже живі, а
   день той самий о будь-якій порі, коли б не запускали тест. */
const soon = () => Date.now() + 60e3;
const order = (extra = {}) => ({ shop: 0, shopName: CAT.SHOPS[0][0], mode: 'pickup', fry: false, fg: 0, pay: 'cash',
  nm: 'Покупець', tel: '+380501112233', note: '', when: 'Сьогодні', slotAt: soon(),
  lines: [{ id: lavash.id, name: lavash.name, grp: lavash.grp, unit: lavash.unit, g: 2 }], total: 0, ...extra });

{
  /* ---- 1. Вхід через Telegram ---- */
  let r = await call('POST', '/api/auth/start');
  const sid = r.d.sid;
  ok('вхід: сайт отримав посилання на бота', r.status === 200 && /t\.me\/test_bot\?start=/.test(r.d.link));
  ok('вхід: до «поділитися» — ще чекаємо', (await call('GET', '/api/auth/poll/' + sid)).d.status === 'wait');
  say(CLIENT, CLIENT, '/start ' + sid);
  ok('вхід: бот просить поділитися номером', toClient(/Натисніть кнопку нижче/));
  contact(CLIENT, CLIENT, '380501112233', 'Богдан');
  r = await call('GET', '/api/auth/poll/' + sid);
  const U = { Authorization: 'Bearer ' + r.d.token };
  ok('вхід: сайт отримав ключ і номер', r.d.status === 'ok' && !!r.d.token && r.d.tel === '+380501112233');
  ok('вхід: ключ видається лише раз', (await call('GET', '/api/auth/poll/' + sid)).d.status !== 'ok');
  r = await call('GET', '/api/me', null, U);
  ok('профіль бачить номер', r.status === 200 && r.d.tel === '+380501112233');

  /* ---- 2. Замовлення з сайту ---- */
  sent.length = 0;
  r = await call('POST', '/api/order', order(), U);
  const no = r.d.no;
  ok('замовлення прийнято, суму рахує сервер', r.status === 200 && no > 0 && r.d.total === CAT.lineSum({ ...lavash, g: 2 }));
  const card = sent.find(x => x.chatId === CHAT && new RegExp('№\\s*' + no).test(x.text));
  ok('картка в чаті точки з кнопкою «Прийняти»', card && card.kb.some(b => b.callback_data === `s:${no}:accepted`));
  r = await call('GET', '/api/me/active', null, U);
  ok('покупець бачить замовлення серед активних', r.d.orders.some(o => o.no === no));
  ok('сторінка замовлення: «нове»', (await call('GET', '/api/order/' + no)).d.status === 'new');

  /* ---- 3. Панель точки ---- */
  ok('панель без ключа — 401', (await call('GET', '/api/op/orders')).status === 401);
  sent.length = 0;
  say(CHAT, 1, '/panel', 'group');
  const code = ((sent[0] || {}).text || '').match(/op\.html#([0-9a-f]+)/);
  r = await call('POST', '/api/op/claim', { code: code && code[1] });
  const P = { Authorization: 'Bearer ' + r.d.token };
  ok('панель: разовий код міняється на ключ', r.status === 200 && !!r.d.token);
  r = await call('GET', '/api/op/orders', null, P);
  const inPanel = (r.d.orders || []).find(o => o.no === no);
  ok('панель бачить замовлення, суму можна правити', inPanel && inPanel.status === 'new' && inPanel.can.money);

  /* «Прийняти» — кнопкою в чаті, далі — з панелі (так і працюють на точці) */
  sent.length = 0;
  await press(CHAT, 5, `s:${no}:accepted`);
  await tick();
  ok('кнопка в чаті: прийнято', (await call('GET', '/api/order/' + no)).d.status === 'accepted');
  ok('покупцю в бот: прийняли', sent.some(x => x.chatId === CLIENT));
  ok('кнопка з чужого чату не діє', await (async () => {
    await press(-999, 5, `s:${no}:cooking`);
    return (await call('GET', '/api/order/' + no)).d.status === 'accepted';
  })());

  /* сума й склад — лише поки не почали готувати */
  const before = (await call('GET', '/api/order/' + no)).d.total;
  r = await call('POST', `/api/op/order/${no}/adjust`, { kind: 'fact', amount: 150, note: 'зважили' }, P);
  ok('🧾 фактична сума', r.status === 200 && r.d.order.total === 150);
  ok('сторінка покупця бачить зміну', (await call('GET', '/api/order/' + no)).d.totalOrig === before);
  r = await call('POST', `/api/op/order/${no}/line`, { act: 'add', id: osh.id, g: 500 }, P);
  const withOsh = r.d.order && r.d.order.total;
  ok('➕ позиція: сума виросла на ціну ошийка', r.status === 200 && Math.abs(withOsh - 150 - CAT.lineSum({ ...osh, g: 500 })) < 0.01);
  r = await call('POST', `/api/op/order/${no}/line`, { act: 'add', id: 'nope', g: 1 }, P);
  ok('➕ неіснуюча позиція — відмова', r.status === 409);
  r = await call('POST', `/api/op/order/${no}/line`, { act: 'del', i: 1 }, P);
  ok('➖ позиція: сума повернулась', r.status === 200 && Math.abs(r.d.order.total - 150) < 0.01);
  r = await call('POST', `/api/op/order/${no}/line`, { act: 'del', i: 0 }, P);
  ok('останню позицію не прибрати — лише скасувати', r.status === 409);
  /* «Зібрано» — позначка для себе: клієнту не йде нічого */
  sent.length = 0;
  r = await call('POST', `/api/op/order/${no}/pack`, { on: true }, P);
  ok('📦 зібрано', r.status === 200 && r.d.order.packed === true);
  ok('клієнт про «Зібрано» не дізнається',
    !sent.some(x => x.chatId === CLIENT) && !JSON.stringify((await call('GET', '/api/order/' + no)).d).includes('pack'));
  r = await call('POST', `/api/op/order/${no}/pack`, { on: false }, P);
  ok('↩ не зібрано', r.status === 200 && r.d.order.packed === false);
  r = await call('POST', `/api/op/order/${no}/pack`, { on: true });
  ok('без ключа панелі — 401', r.status === 401);
  await call('POST', `/api/op/order/${no}/pack`, { on: true }, P);
  r = await call('POST', `/api/op/order/${no}/status`, { status: 'cooking' }, P);
  ok('панель: готується', r.status === 200 && r.d.order.status === 'cooking');
  ok('картку в чаті оновлено', edits.some(e => e.chatId === CHAT));
  r = await call('POST', `/api/op/order/${no}/status`, { status: 'done' }, P);
  ok('через крок не перестрибнути', r.status === 409);

  r = await call('POST', `/api/op/order/${no}/adjust`, { kind: 'fact', amount: 999 }, P);
  ok('після «Готується» суму не змінити', r.status === 409);
  r = await call('POST', `/api/op/order/${no}/time`, { at: soon() + 3600e3 }, P);
  ok('🕒 час після «Готується» не міняється', r.status === 409);

  sent.length = 0;
  r = await call('POST', `/api/op/order/${no}/status`, { status: 'ready' }, P);
  ok('панель: готове', r.status === 200 && r.d.order.status === 'ready');
  ok('покупцю в бот: готове', sent.some(x => x.chatId === CLIENT));
  r = await call('POST', `/api/op/order/${no}/status`, { status: 'done' }, P);
  ok('панель: видано', r.status === 200 && r.d.order.status === 'done');
  r = await call('GET', '/api/me/active', null, U);
  ok('видане зникає з активних покупця', !r.d.orders.some(o => o.no === no));
  r = await call('GET', '/api/me/orders', null, U);
  ok('видане — в історії покупця', r.d.orders.some(o => o.no === no));

  /* ---- 4. Доставка без входу: вартість, курʼєр, «отримав» ---- */
  r = await call('POST', '/api/order', order({ mode: 'delivery', tel: '+380671112233', addr: 'вул. Сумська 1, кв. 2' }));
  const dno = r.d.no, ckey = r.d.ckey;
  ok('доставка прийнята, у покупця є ключ замовлення', r.status === 200 && !!ckey);
  for (const st of ['accepted', 'cooking']) await call('POST', `/api/op/order/${dno}/status`, { status: st }, P);
  r = await call('POST', `/api/op/order/${dno}/adjust`, { kind: 'ship', amount: 120 }, P);
  ok('🚕 вартість доставки додана до суми', r.status === 200 && Math.abs(r.d.order.total - CAT.lineSum({ ...lavash, g: 2 }) - 120) < 0.01);
  for (const st of ['ready', 'onway']) await call('POST', `/api/op/order/${dno}/status`, { status: st }, P);
  ok('передали курʼєру', (await call('GET', '/api/order/' + dno)).d.status === 'onway');
  ok('«отримав» без ключа — відмова', (await call('POST', `/api/order/${dno}/received`, { key: 'bad' })).status === 403);
  r = await call('POST', `/api/order/${dno}/received`, { key: ckey });
  ok('покупець підтвердив — доставлено', r.status === 200 && (await call('GET', '/api/order/' + dno)).d.status === 'done');
  ok('точці — що клієнт отримав', sent.some(x => x.chatId === CHAT && /Клієнт підтвердив/.test(x.text)));

  /* ---- 5. Перенесення часу й скасування з причиною ---- */
  r = await call('POST', '/api/order', order({ slotAt: soon() + 24 * 3600e3, when: 'Завтра' }), U);
  const cno = r.d.no;
  r = await call('GET', `/api/op/order/${cno}/times`, null, P);
  const slot = r.d.days && r.d.days.length && r.d.days[r.d.days.length - 1].slots[0];
  ok('🕒 сервер дає слоти на кілька днів', r.status === 200 && r.d.days.length >= 2 && !!slot);
  sent.length = 0;
  r = await call('POST', `/api/op/order/${cno}/time`, { at: slot.at }, P);
  ok('🕒 час перенесено', r.status === 200 && r.d.order.slotAt === slot.at);
  ok('🕒 покупцю — новий час', toClient(/новий час/));
  ok('🕒 на нічний час — відмова', (await call('POST', `/api/op/order/${cno}/time`, { at: slot.at - 6 * 3600e3 }, P)).status === 409);
  sent.length = 0;
  r = await call('POST', `/api/op/order/${cno}/adjust`, { kind: 'cancel', note: 'клієнт передумав' }, P);
  ok('✖️ скасовано з причиною', r.status === 200 && r.d.order.status === 'canceled');
  ok('✖️ покупцю — скасування з причиною', toClient(/клієнт передумав/));
  r = await call('POST', `/api/op/order/${cno}/status`, { status: 'accepted' }, P);
  ok('скасоване не оживити', r.status === 409);

  /* ---- 6. Стоп-лист ---- */
  r = await call('POST', '/api/op/stock', { id: osh.id, off: true }, P);
  ok('🚫 позицію знято', r.status === 200 && (await call('GET', '/api/stock?shop=0')).d.off.includes(osh.id));
  r = await call('POST', '/api/order', order({ lines: [{ id: osh.id, name: osh.name, grp: osh.grp, unit: osh.unit, g: 500 }] }), U);
  ok('🚫 сайт не приймає зняту позицію і каже яку', r.status === 409 && r.d.gone && r.d.gone.includes(osh.id));
  await call('POST', '/api/op/stock', { id: osh.id, off: false }, P);
  ok('✅ позицію повернуто', !(await call('GET', '/api/stock?shop=0')).d.off.includes(osh.id));

  /* ---- 7. Мангал ---- */
  r = await call('POST', '/api/op/grill', { act: '60' }, P);
  ok('🔥 мангал закрито на годину', r.status === 200 && (await call('GET', '/api/grill?shop=0')).d.busyUntil > Date.now() + 50 * 60e3);
  await call('POST', '/api/op/grill', { act: 'free' }, P);
  ok('🔥 мангал знову вільний', !((await call('GET', '/api/grill?shop=0')).d.busyUntil > Date.now()));

  /* ---- 8. /panel-off відкликає планшет ---- */
  say(CHAT, 1, '/panel-off', 'group');
  ok('після /panel-off ключ панелі не діє', (await call('GET', '/api/op/orders', null, P)).status === 401);

  cleanup();
  report(t);
}
