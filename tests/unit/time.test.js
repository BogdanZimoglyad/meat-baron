/* Перевірка перенесення часу замовлення на справжньому коді: вирізаємо
   з server.js увесь блок від TIME_STATUSES до applyTime і переносимо
   підставлене замовлення. Київський час рахуємо самі, тож перевіряємо
   й сам перерахунок — сервер живе за UTC.
   Запуск: npm test */
const fs = require('fs');
const report = require('../report.js');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

const cut = re => { const m = src.match(re); if (!m) { throw new Error('не знайшли: ' + re) } return m[0] };
const code = cut(/const TIME_STATUSES[\s\S]*?async function applyTime\(o, raw, by\) \{[\s\S]*?\n\}/);

const HOUR = 3600e3;
let load = {}, busyUntil = 0, extra = {};
let notified = [];
const env = {
  HOUR, OPEN_HOUR: 8,
  kyivDate: (ts = Date.now()) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }),
  hhmm: ms => new Date(ms).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }),
  hourFloor: ms => Math.floor(ms / HOUR) * HOUR,
  grillLoad: () => load,
  capOf: (shop, at) => 10000 + (extra[Math.floor(at / HOUR) * HOUR] || 0),
  grillBusyUntil: () => (busyUntil > Date.now() ? busyUntil : 0),
  wLabel: g => (g >= 1000 ? (g / 1000).toFixed(g % 100 ? 2 : g % 1000 ? 1 : 0) + ' кг' : g + ' г'),
  adjustmentsOf: o => (Array.isArray(o.adjust) ? o.adjust : []),
  save: () => {},
  editCard: async () => {},
  notifyAdjust: (o, a) => notified.push(a)
};
const api = new Function(...Object.keys(env),
  `${code}; return { kyivMs, timeChoices, applyTime, timeLabel, dayLabelK, whenOf }`)(...Object.values(env));

/* Завтра за Києвом — від нього будуємо всі слоти, щоб тест не залежав
   від того, о котрій його запускають. */
const tomorrow = env.kyivDate(Date.now() + 24 * HOUR);
const at = (h, m = 0, day = tomorrow) => api.kyivMs(day, h, m);
const order = (over = {}) => ({ no: 7, shop: 0, status: 'accepted', mode: 'pickup', fry: false, fg: 0,
  total: 500, slotAt: at(12), when: 'Завтра · о 12:00', ...over });

const t = [];
const ok = (name, cond) => t.push([name, cond]);

{
  // ---------- київський час ----------
  ok('влітку 14:00 Києва — це 11:00 UTC', new Date(api.kyivMs('2026-07-01', 14, 0)).getUTCHours() === 11);
  ok('узимку 14:00 Києва — це 12:00 UTC', new Date(api.kyivMs('2026-12-01', 14, 0)).getUTCHours() === 12);
  ok('рядок для самовивозу', api.timeLabel({ mode: 'pickup' }, at(14)) === 'Завтра · о 14:00');
  ok('рядок для доставки — «орієнтовно»', api.timeLabel({ mode: 'delivery' }, at(14)) === 'Завтра · орієнтовно о 14:00');
  ok('далекий день — як на сайті', /^(Нд|Пн|Вт|Ср|Чт|Пт|Сб), \d+ [а-яі]+$/.test(api.dayLabelK(env.kyivDate(Date.now() + 4 * 24 * HOUR))));

  // ---------- що можна обрати ----------
  const days = api.timeChoices(order());
  const tm = days.find(d => d.day === tomorrow);
  ok('два тижні наперед', days.length >= 13 && days.length <= 14);
  ok('сире — з 08:00', tm && tm.slots[0].label === '08:00');
  ok('крок пів години', tm && tm.slots[1].at - tm.slots[0].at === 30 * 60000);
  const sunday = days.find(d => d.label.startsWith('Нд') || new Date(d.day + 'T12:00Z').getUTCDay() === 0);
  const weekday = days.find(d => d.day !== env.kyivDate() && new Date(d.day + 'T12:00Z').getUTCDay() !== 0);
  ok('у будні останній слот 19:30', weekday && weekday.slots[weekday.slots.length - 1].label === '19:30');
  ok('у неділю останній слот 18:30', sunday && sunday.slots[sunday.slots.length - 1].label === '18:30');
  const fryDays = api.timeChoices(order({ fry: true, fg: 1000 }));
  ok('на мангал — з 10:00', fryDays.find(d => d.day === tomorrow).slots[0].label === '10:00');
  ok('минулих слотів немає', days.every(d => d.slots.every(s => s.at > Date.now())));

  // ---------- перенесення ----------
  notified = [];
  let o = order();
  let r = await api.applyTime(o, { at: at(14), note: 'клієнт попросив' }, 'панель');
  ok('перенесли', r.ok && o.slotAt === at(14));
  ok('новий рядок часу', o.when === 'Завтра · о 14:00');
  ok('клієнту пішов коментар з новим і старим часом', notified.length === 1 && notified[0].kind === 'note'
    && notified[0].note.includes('Завтра · о 14:00') && notified[0].note.includes('було: Завтра · о 12:00')
    && notified[0].note.includes('клієнт попросив'));
  ok('сума не змінилась, але зафіксована як початкова', o.total === 500 && o.totalOrig === 500);

  o = order({ status: 'cooking' });
  r = await api.applyTime(o, { at: at(14) }, 'п');
  ok('коли вже готують — не можна', !!r.err && o.slotAt === at(12));
  o = order({ status: 'new' });
  r = await api.applyTime(o, { at: at(14) }, 'п');
  ok('нове замовлення — можна', r.ok);
  r = await api.applyTime(order(), { at: at(14, 15) }, 'п');
  ok('не на сітці пів години — ні', !!r.err);
  r = await api.applyTime(order(), { at: at(21) }, 'п');
  ok('після закриття — ні', !!r.err);
  r = await api.applyTime(order(), { at: Date.now() - HOUR }, 'п');
  ok('у минуле — ні', !!r.err);
  r = await api.applyTime(order(), { at: at(12) }, 'п');
  ok('той самий час — ні', !!r.err);
  r = await api.applyTime(order({ fry: true, fg: 1000 }), { at: at(9) }, 'п');
  ok('на мангал до 10:00 — ні', !!r.err);

  // ---------- мангал ----------
  load = { [env.hourFloor(at(15))]: 9000 };
  o = order({ fry: true, fg: 2000 });
  r = await api.applyTime(o, { at: at(15) }, 'п');
  ok('забита година — питаємо, не міняємо', !!r.warn && o.slotAt === at(12));
  r = await api.applyTime(o, { at: at(15), force: true }, 'п');
  ok('підтвердили — ставимо', r.ok && o.slotAt === at(15));
  extra = { [env.hourFloor(at(16))]: 5000 };
  load = { [env.hourFloor(at(16))]: 12000 };
  r = await api.applyTime(order({ fry: true, fg: 2000 }), { at: at(16) }, 'п');
  ok('надбавка «+5 кг» враховується', r.ok);
  extra = {};

  /* Переносимо в межах тієї ж години: замовлення вже сидить у завантаженні
     цієї години й не має заважати саме собі. */
  load = { [env.hourFloor(at(14))]: 8000 };
  o = order({ fry: true, fg: 8000, slotAt: at(14) });
  r = await api.applyTime(o, { at: at(14, 30) }, 'п');
  ok('у межах години — себе не рахуємо', r.ok);
  const mark = api.timeChoices(order({ fry: true, fg: 8000, slotAt: at(14) })).find(d => d.day === tomorrow);
  ok('слот тієї ж години не позначено як забитий', mark.slots.find(s => s.at === at(14, 30)).full === false);
  load = {};

  busyUntil = at(18);
  r = await api.applyTime(order({ fry: true, fg: 1000 }), { at: at(17) }, 'п');
  ok('мангал закритий кнопкою — питаємо', !!r.warn);
  r = await api.applyTime(order({ fry: false }), { at: at(17) }, 'п');
  ok('сире мангал не чіпає', r.ok);
  busyUntil = 0;

  /* Рядок часу — з точного часу за Києвом, а не той, що прислав телефон
     (власник, 02.10: № 1058, «Завтра · о 17:00» при 18:00 сьогодні) */
  ok('рядок часу рахується з точного часу',
    api.whenOf({ mode: 'pickup', slotAt: at(18), when: 'Сьогодні · о 17:00' }) === 'Завтра · о 18:00');
  ok('доставка — «орієнтовно о»',
    api.whenOf({ mode: 'delivery', slotAt: at(18), when: '' }) === 'Завтра · орієнтовно о 18:00');
  ok('«якнайшвидше» лишається «орієнтовно з»',
    api.whenOf({ mode: 'pickup', slotAt: at(10, 40), when: 'Готове орієнтовно з 10:40' }) === 'Завтра · готове орієнтовно з 10:40');
  ok('без часу — збережений рядок', api.whenOf({ when: 'якнайшвидше' }) === 'якнайшвидше');

  report(t);
}
