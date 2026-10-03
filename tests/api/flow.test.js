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
  /* ✏️ вага на місці, без прибирання позиції (02.10) */
  r = await call('POST', `/api/op/order/${no}/line`, { act: 'set', i: 0, g: 3 }, P);
  ok('✏️ кількість змінено, позиція одна', r.status === 200 && r.d.order.lines.length === 1 && r.d.order.lines[0].qty === 3);
  r = await call('POST', `/api/op/order/${no}/line`, { act: 'set', i: 0, g: 3 }, P);
  ok('✏️ та сама кількість — відмова', r.status === 409);
  r = await call('POST', `/api/op/order/${no}/line`, { act: 'set', i: 0, g: 2 }, P);
  ok('✏️ назад до двох', r.status === 200 && r.d.order.lines[0].qty === 2 && Math.abs(r.d.order.total - 150) < 0.01);
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

  /* ↩ назад у «Прийнято»: клієнт переніс час, а вже «Готується»
     (власник, 02.10). Знову відкриваються час, сума й склад. */
  sent.length = 0;
  r = await call('POST', `/api/op/order/${no}/back`, {}, P);
  ok('↩ панель: знову «Прийнято»', r.status === 200 && r.d.order.status === 'accepted');
  ok('↩ час, сума й склад знову відкриті', r.d.order.can.time && r.d.order.can.money && !r.d.order.can.back);
  ok('↩ клієнту про відкат не пишемо', !sent.some(x => x.chatId === CLIENT));
  r = await call('POST', `/api/op/order/${no}/adjust`, { kind: 'fact', amount: 160 }, P);
  ok('↩ після відкату суму змінити можна', r.status === 200 && r.d.order.total === 160);
  r = await call('POST', `/api/op/order/${no}/back`, {}, P);
  ok('↩ з «Прийнято» назад нікуди', r.status === 409);
  r = await call('POST', `/api/op/order/${no}/back`, {});
  ok('↩ без ключа панелі — 401', r.status === 401);
  /* те саме кнопкою в чаті точки; повторне «Готується» клієнту вдруге не пишемо */
  await call('POST', `/api/op/order/${no}/status`, { status: 'cooking' }, P);
  await press(-999, 5, `b:${no}`);
  ok('↩ кнопка з чужого чату не діє', (await call('GET', '/api/order/' + no)).d.status === 'cooking');
  await press(CHAT, 5, `b:${no}`);
  await tick();
  ok('↩ кнопка в чаті: знову «Прийнято»', (await call('GET', '/api/order/' + no)).d.status === 'accepted');
  sent.length = 0;
  r = await call('POST', `/api/op/order/${no}/status`, { status: 'cooking' }, P);
  ok('↩ знову «Готується»', r.status === 200 && r.d.order.status === 'cooking');
  ok('↩ про «Готується» клієнту вдруге не пишемо', !sent.some(x => x.chatId === CLIENT));

  sent.length = 0;
  r = await call('POST', `/api/op/order/${no}/status`, { status: 'ready' }, P);
  ok('панель: готове', r.status === 200 && r.d.order.status === 'ready');
  ok('покупцю в бот: готове', sent.some(x => x.chatId === CLIENT));
  /* Посилання клієнту — з ключем: відкрите в браузері Telegram без входу,
     воно все одно покаже суму (аудит 02.10) */
  ok('посилання покупцю — з ключем замовлення', sent.some(x => x.chatId === CLIENT && x.kb.some(b => /[?&]k=[0-9a-f]+/.test(b.url || ''))));
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

  /* ---- 4а. Чуже замовлення за номером: лише статус (аудит 02.10) ---- */
  r = await call('GET', '/api/order/' + dno);
  ok('за голим номером — статус є, суми й коментарів немає', r.d.status === 'done' && r.d.total === undefined && r.d.adjust === undefined);
  r = await call('GET', '/api/order/' + dno + '?k=' + ckey);
  ok('з ключем замовлення — сума й зміни оператора', r.d.total > 0 && Array.isArray(r.d.adjust));
  ok('з чужим ключем — лише статус', (await call('GET', '/api/order/' + dno + '?k=bad')).d.total === undefined);
  ok('хто увійшов — бачить суму свого', (await call('GET', '/api/order/' + no, null, U)).d.total > 0);
  ok('хто увійшов — суми чужого не бачить', (await call('GET', '/api/order/' + dno, null, U)).d.total === undefined);

  /* ---- 4б. Підписка на push: лише своє замовлення й лише справжні сервіси ---- */
  const push = { endpoint: 'https://fcm.googleapis.com/fcm/send/x1', keys: { p256dh: 'p', auth: 'a' } };
  ok('push: чужим ключем — ні', (await call('POST', '/api/push/subscribe', { no: dno, key: 'bad', sub: push })).status === 403);
  ok('push: на внутрішню адресу — ні', (await call('POST', '/api/push/subscribe', { no: dno, key: ckey, sub: { ...push, endpoint: 'https://127.0.0.1/x' } })).status === 400);
  ok('push: своє замовлення — так', (await call('POST', '/api/push/subscribe', { no: dno, key: ckey, sub: push })).status === 200);

  /* ---- 4в. Час поза графіком — точці попередження, а не відмова клієнту ---- */
  const kyivNoon = days => {
    const d = new Date(Date.now() + days * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
    const guess = Date.parse(d + 'T12:00:00Z');
    const h = Number(new Date(guess).toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }));
    return guess - (h - 12) * 3600e3;
  };
  sent.length = 0;
  r = await call('POST', '/api/order', order({ slotAt: kyivNoon(40), when: 'Колись' }));
  ok('замовлення на місяць уперед прийнято', r.status === 200);
  ok('…а в картці точки — «час поза графіком»', sent.some(x => x.chatId === CHAT && /поза графіком/.test(x.text)));
  await call('POST', `/api/op/order/${r.d.no}/adjust`, { kind: 'cancel', note: 'тест' }, P);
  sent.length = 0;
  r = await call('POST', '/api/order', order({ slotAt: kyivNoon(2), when: 'Післязавтра' }));
  ok('звичайний час — без попередження', r.status === 200 && !sent.some(x => /поза графіком/.test(x.text)));
  await call('POST', `/api/op/order/${r.d.no}/adjust`, { kind: 'cancel', note: 'тест' }, P);

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

  /* ---- 7а. Пауза приймання з панелі (02.10) ---- */
  const OWNER = 777;
  const now = () => Date.now();                       // «на зараз» — точно сьогодні, хоч о 23:59
  const cancel = n => call('POST', `/api/op/order/${n}/adjust`, { kind: 'cancel', note: 'тест' }, P);
  sent.length = 0;
  r = await call('POST', '/api/op/pause', { what: 'all', dur: 'day' }, P);
  ok('⏸ пауза поставлена', r.status === 200 && r.d.pause.all > Date.now());
  ok('⏸ власнику в особисті — хто й на скільки', sent.some(x => x.chatId === OWNER && /⏸.*увесь прийом/.test(x.text)));
  ok('⏸ і в чат точки', sent.some(x => x.chatId === CHAT && /⏸/.test(x.text)));
  ok('⏸ сайт бачить паузу разом зі стоп-листом', (await call('GET', '/api/stock?shop=0')).d.pause.all > Date.now());
  ok('⏸ панель бачить паузу в шапці', (await call('GET', '/api/op/orders', null, P)).d.pause.all > Date.now());
  r = await call('POST', '/api/order', order({ slotAt: now() }));
  ok('⏸ на сьогодні — відмова з поясненням', r.status === 409 && /тимчасово не приймає/.test(r.d.error));
  r = await call('POST', '/api/order', order({ slotAt: kyivNoon(2), when: 'Післязавтра' }));
  ok('⏸ на інший день — приймаємо', r.status === 200);
  await cancel(r.d.no);
  sent.length = 0;
  r = await call('POST', '/api/op/pause', { what: 'all', dur: 'off' }, P);
  ok('▶️ паузу знято, власнику сказали', r.status === 200 && !r.d.pause.all && sent.some(x => x.chatId === OWNER && /▶️/.test(x.text)));
  r = await call('POST', '/api/order', order({ slotAt: now() }));
  ok('▶️ на сьогодні знову приймаємо', r.status === 200);
  await cancel(r.d.no);
  ok('⏸ невідома тривалість — ні', (await call('POST', '/api/op/pause', { what: 'all', dur: '999' }, P)).status === 400);

  await call('POST', '/api/op/pause', { what: 'delivery', dur: '60' }, P);
  r = await call('POST', '/api/order', order({ slotAt: now(), mode: 'delivery', addr: 'вул. Сумська 1' }));
  ok('🚕 пауза доставки: доставку на сьогодні не приймаємо', r.status === 409 && /Доставка/.test(r.d.error));
  r = await call('POST', '/api/order', order({ slotAt: now() }));
  ok('🚕 пауза доставки: самовивіз приймаємо', r.status === 200);
  await cancel(r.d.no);
  await call('POST', '/api/op/pause', { what: 'delivery', dur: 'off' }, P);

  /* ---- 7б. Свята й короткі дні — лише власник, у боті (02.10) ---- */
  const hol = new Date(kyivNoon(3)).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  await press(555, 555, `hd:k:a:${hol}:0`);
  ok('📅 не власник свято не поставить', (await call('GET', '/api/stock?shop=0')).d.days[hol] === undefined);
  sent.length = 0;
  await press(OWNER, OWNER, `hd:k:a:${hol}:0`);
  ok('📅 власник зачинив день — сайт це бачить', (await call('GET', '/api/stock?shop=0')).d.days[hol] === 0);
  ok('📅 точці в чат — що день особливий', sent.some(x => x.chatId === CHAT && /📅/.test(x.text)));
  r = await call('POST', '/api/order', order({ slotAt: kyivNoon(3), when: 'Свято' }));
  ok('📅 на зачинений день — відмова', r.status === 409 && /зачинена/.test(r.d.error));
  r = await call('POST', '/api/order', order({ slotAt: kyivNoon(2), when: 'Післязавтра' }));
  const tno = r.d.no;
  r = await call('GET', `/api/op/order/${tno}/times`, null, P);
  ok('📅 панель не дає перенести на свято', r.status === 200 && !r.d.days.some(d => d.day === hol));
  await cancel(tno);

  await press(OWNER, OWNER, `hd:k:0:${hol}:15`);
  ok('🕒 короткий день: точка важливіша за «усі»', (await call('GET', '/api/stock?shop=0')).d.days[hol] === 15);
  r = await call('POST', '/api/order', order({ slotAt: kyivNoon(3) + 4 * 3600e3, when: '16:00' }));
  ok('🕒 короткий день: після закриття — відмова', r.status === 409 && /до 15:00/.test(r.d.error));
  r = await call('POST', '/api/order', order({ slotAt: kyivNoon(3), when: '12:00' }));
  ok('🕒 короткий день: до закриття — приймаємо', r.status === 200);
  await cancel(r.d.no);

  await press(OWNER, OWNER, `hd:k:0:${hol}:x`);
  await press(OWNER, OWNER, `hd:k:a:${hol}:x`);
  ok('✅ звичайний день — особливе прибрано', (await call('GET', '/api/stock?shop=0')).d.days[hol] === undefined);
  sent.length = 0;
  say(OWNER, OWNER, '/days');
  ok('📅 /days — власнику список і кнопка «Додати»', sent.some(x => x.chatId === OWNER && x.kb.some(b => b.callback_data === 'hd:n')));
  sent.length = 0;
  say(-100, 1, '/days', 'group');
  ok('📅 /days у чаті точки мовчить', !sent.length);

  /* ---- 7б. самовивіз ↔ доставка: клієнт передумав (03.10) ---- */
  {
    const base = CAT.lineSum({ ...lavash, g: 2 });
    let m = await call('POST', '/api/order', order({ tel: '+380671119911', pay: 'card' }));
    const mno = m.d.no;
    m = await call('POST', `/api/op/order/${mno}/mode`, { mode: 'delivery', addr: '' }, P);
    ok('🔁 на доставку без адреси — відмова', m.status === 409 && /адресу/.test(m.d.error));
    m = await call('POST', `/api/op/order/${mno}/mode`, { mode: 'delivery', addr: 'вул. Сумська 10, кв. 5' }, P);
    ok('🔁 на доставку: спосіб, адреса, оплата готівкою курʼєру', m.status === 200 && m.d.order.mode === 'delivery'
      && m.d.order.addr === 'вул. Сумська 10, кв. 5' && m.d.order.pay === 'cash' && m.d.order.can.ship);
    m = await call('POST', `/api/op/order/${mno}/adjust`, { kind: 'ship', amount: 150 }, P);
    ok('🔁 після переводу 🚕 вартість додається', Math.abs(m.d.order.total - base - 150) < 0.01);
    m = await call('POST', `/api/op/order/${mno}/mode`, { mode: 'pickup' }, P);
    ok('🔁 назад на самовивіз: вартість доставки знято', m.status === 200 && m.d.order.mode === 'pickup'
      && Math.abs(m.d.order.total - base) < 0.01 && m.d.order.adjust.some(a => a.kind === 'sub' && a.amount === 150));
    m = await call('POST', `/api/op/order/${mno}/mode`, { mode: 'pickup' }, P);
    ok('🔁 «вже самовивіз» — відмова', m.status === 409);
    for (const st of ['accepted', 'cooking', 'ready', 'done']) await call('POST', `/api/op/order/${mno}/status`, { status: st }, P);
    m = await call('POST', `/api/op/order/${mno}/mode`, { mode: 'delivery', addr: 'вул. Сумська 10' }, P);
    ok('🔁 після «Видано» спосіб не змінити', m.status === 409);
  }

  /* ---- 8. /panel-off відкликає планшет ---- */
  say(CHAT, 1, '/panel-off', 'group');
  ok('після /panel-off ключ панелі не діє', (await call('GET', '/api/op/orders', null, P)).status === 401);

  cleanup();
  report(t);
}
