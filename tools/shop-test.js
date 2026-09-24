/* Перевірка стоп-листа й мангала на справжньому коді: вирізаємо з
   server.js applyStock, applyGrill і те, з чого вони рахують стан, і
   ганяємо на підставленій базі. Ці ж функції кличуть і бот, і панель —
   тож тест накриває обидва входи одразу.
   Запуск: node tools/shop-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CAT = require(path.join(__dirname, '..', 'catalog.js'));

const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли: ' + re); process.exit(1) } return m[0] };
const code = [
  cut(/const HOUR = 3600e3;[\s\S]*?const hourFloor = ms => Math\.floor\(ms \/ HOUR\) \* HOUR;/),
  cut(/const kyivNow = \(\) =>[\s\S]*?\n\}/),            // kyivNow + tillCloseMs
  cut(/const extraOf = shop => \{[\s\S]*?\n\};/),
  cut(/const grillBusyUntil = shop => \{[\s\S]*?\n\};/),
  cut(/function grillLoad\(shop\) \{[\s\S]*?\n\}/),
  cut(/const nextSlots = \(n = 3\) => \{[\s\S]*?\n\};/),
  cut(/function stopOf\(shop\) \{[\s\S]*?\n\}/),
  cut(/function applyGrill\(shop, act, arg\) \{[\s\S]*?\n\}/),
  cut(/function applyStock\(shop, id, off\) \{[\s\S]*?\n\}/),
  cut(/const opShopState = shop => \{[\s\S]*?\n\};/)
].join('\n');

const HOUR = 3600e3, KG = 1000;
const byId = new Map(CAT.ITEMS.map(i => [i.id, i]));
const id = name => CAT.ITEMS.find(i => i.name === name).id;
const OPEN = 8;

let saved = 0;
const env = {
  byId, nameOf: CAT.nameOf, OPEN_HOUR: OPEN,
  ADD_STEP_G: 5000, CANCELED: 'canceled',   // GRILL_CAP_G приїжджає разом із вирізаним кодом
  wLabel: g => (g >= 1000 ? (g / 1000).toFixed(g % 100 ? 2 : g % 1000 ? 1 : 0) + ' кг' : g + ' г'),
  hhmm: ms => new Date(ms).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }),
  /* повернення о 8:00 нас тут не цікавить — важливо лише, що мітка в майбутньому */
  nextOpenMs: () => Date.now() + 10 * HOUR,
  save: () => { saved++ },
  db: null
};
const build = db => {
  env.db = db;
  const fn = new Function(...Object.keys(env),
    `${code}; return { applyGrill, applyStock, opShopState, stopOf, grillLoad }`);
  return fn(...Object.values(env));
};
const freshDb = (orders = {}) => ({ orders, busy: {}, extra: {}, stop: {} });

const t = [];
const ok = (name, cond) => t.push([name, cond]);

// ---------- мангал ----------
let db = freshDb();
let s = build(db);

let r = s.applyGrill(0, '60');
ok('«зайнятий на годину» закриває мангал', r.ok && db.busy[0] > Date.now() + 59 * 60000);
ok('оператору кажуть, до котрої', /Закрито до \d\d:\d\d/.test(r.note));

r = s.applyGrill(0, 'free');
ok('«вільний» знімає блокування', r.ok && !db.busy[0]);

r = s.applyGrill(0, 'нісенітниця');
ok('невідома дія не міняє нічого', !!r.err && !db.busy[0]);
ok('і 0 хвилин теж не приймаємо', !!s.applyGrill(0, '0').err);
ok('і закрити на тиждень не дамо', !!s.applyGrill(0, '10000').err);

const soon = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
r = s.applyGrill(0, 'add', soon);
ok('надбавка лягає саме на цю годину', r.ok && db.extra[0][soon] === 5000);
s.applyGrill(0, 'add', soon);
ok('друге натискання додає ще', db.extra[0][soon] === 10000);

const past = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
ok('на минулу годину надбавку не приймаємо', !!s.applyGrill(0, 'add', past).err);

// надбавка знімає загальне блокування, якщо воно накривало цю годину
db.busy[0] = soon + HOUR;
s.applyGrill(0, 'add', soon);
ok('надбавка відкриває закриту годину', db.busy[0] === soon);

s.applyGrill(0, 'noadd');
ok('«прибрати надбавки» чистить усі', Object.keys(db.extra[0]).length === 0);

// точки не заважають одна одній
db = freshDb(); s = build(db);
s.applyGrill(1, '60');
ok('закрили одну точку — друга приймає', !!db.busy[1] && !db.busy[0]);

// ---------- стоп-лист ----------
db = freshDb(); s = build(db);
const neck = id('Ошийок');

r = s.applyStock(0, neck, true);
ok('позиція йде в стоп', r.ok && !!s.stopOf(0)[neck]);
ok('у відповіді — назва з прайсу', r.note.includes('Ошийок'));
r = s.applyStock(0, neck, false);
ok('і повертається назад', r.ok && !s.stopOf(0)[neck]);
ok('вигаданий номер позиції відхиляємо', !!s.applyStock(0, 'немає-такого', true).err);

s.applyStock(0, neck, true);
ok('стоп однієї точки не чіпає іншу', !s.stopOf(1)[neck]);

// протухла мітка відпадає сама
db.stop[0][neck] = Date.now() - 1000;
ok('учорашній стоп не рахується', !s.stopOf(0)[neck]);

// ---------- стан для панелі ----------
db = freshDb(); s = build(db);
let st = s.opShopState(0);
ok('панель отримує години, підписи й ліміт',
  Array.isArray(st.grill.slots) && st.grill.labels.length === st.grill.slots.length && st.grill.cap === 10000);
/* Скільки саме годин лишилось — залежить від часу запуску тесту (увечері
   їх нема зовсім). Перевіряємо те, що має бути завжди: години йдуть
   поспіль уперед, жодної з минулого, і не більше пʼяти. */
ok('години йдуть поспіль і лише попереду',
  st.grill.slots.length <= 5
  && st.grill.slots.every((ms, i) => ms > Date.now() && (!i || ms - st.grill.slots[i - 1] === HOUR)));
ok('час і година відкриття їдуть у відповіді', st.now > 0 && st.openHour === OPEN);

// завантаження рахується по справжніх замовленнях і не рахує скасовані
const slot = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
db = freshDb({
  1: { shop: 0, fry: true, fg: 3 * KG, slotAt: slot, status: 'accepted' },
  2: { shop: 0, fry: true, fg: 2 * KG, slotAt: slot, status: 'canceled' },
  3: { shop: 1, fry: true, fg: 9 * KG, slotAt: slot, status: 'accepted' }
});
s = build(db);
ok('лічимо лише свою точку й лише незскасоване', s.grillLoad(0)[slot] === 3 * KG);

let bad = 0;
for (const [name, good] of t) { console.log((good ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!good) bad++ }
console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad ? 1 : 0);
