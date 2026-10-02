/* Перевірка розмітки панелі точки на справжньому коді: вирізаємо з op.html
   card, more, formHtml і NEXT/FORM і малюємо картки на підставлених
   замовленнях. Так видно, які кнопки побачить оператор.
   Запуск: npm test */
const fs = require('fs');
const report = require('../report.js');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'op.html'), 'utf8');

const cut = re => { const m = src.match(re); if (!m) { throw new Error('не знайшли: ' + re) } return m[0] };
const code = [
  cut(/const NEXT=\{[\s\S]*?\n  : NEXT\[o\.status\]\|\|null;/),
  cut(/function dayWord\(ms\)\{[\s\S]*?\n\}/),
  cut(/function card\(o,now\)\{[\s\S]*?\n\}/),
  cut(/function more\(o\)\{[\s\S]*?\n\}/),
  cut(/const FORM=\{[\s\S]*?\n\};/),
  cut(/function formHtml\(o,kind\)\{[\s\S]*?\n\}/),
  cut(/function timeForm\(o\)\{[\s\S]*?\n\}/),
  cut(/function tCal\(days,sel\)\{[\s\S]*?\n\}/),
  cut(/const WD=\[[^\n]*/),
  cut(/const dAdd=[^\n]*/),
  cut(/const dWeek=[^\n]*/),
  cut(/const telGroups=[^\n]*/),
  cut(/const groupOf=o=>[\s\S]*?: 1;/),
  cut(/function dayStrip\(d\)\{[\s\S]*?\n\}/)
].join('\n');

const env = {
  esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  money: n => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '') + ' ₴',
  hhmm: ms => new Date(ms).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }),
  wLabel: g => (g >= 1000 ? (g / 1000).toFixed(g % 100 ? 2 : g % 1000 ? 1 : 0) + ' кг' : g + ' г')
};
/* form — це стан панелі: яка картка зараз розгорнута у форму */
const draw = (o, now, openForm) => {
  const fn = new Function('esc', 'money', 'hhmm', 'wLabel', 'form', 'o', 'now',
    `${code}; return card(o,now)`);
  return fn(env.esc, env.money, env.hhmm, env.wLabel, openForm || null, o, now);
};
/* Купка, в яку потрапить замовлення, і смужка підсумку дня */
const pick = what => {
  const fn = new Function('esc', 'money', 'hhmm', 'wLabel', 'form',
    `${code}; return ${what}`);
  return fn(env.esc, env.money, env.hhmm, env.wLabel, null);
};

const MIN = 60000, NOW = Date.now();
const ord = (o = {}) => ({
  no: 101, status: 'new', label: 'Нове', mode: 'pickup', pay: 'cash',
  nm: 'Богдан', tel: '+380 67 000 00 00', addr: '', note: '',
  total: 500, totalOrig: 500, fry: false, fg: 0, slotAt: NOW + 90 * MIN, startAt: 0,
  lines: [{ name: 'Ошийок', qty: 1000, unit: 'вага', sum: 500 }],
  can: { money: true, ship: false, cancel: true }, ...o
});

const t = [];
const has = (h, s) => h.includes(s);

// 1. повний набір дрібних дій там, де сервер їх дозволяє
let h = draw(ord(), NOW);
t.push(['сума, додати, прибрати, коментар — видно, поки можна',
  ['fact', 'plus', 'minus', 'note'].every(k => has(h, `data-kind="${k}"`))]);
/* ➕ і ➖ тепер про склад замовлення, а не про гроші: правка суми
   лишилась однією кнопкою «🧾 Сума» (власник, 28.09). */
t.push(['грошових ➕ і ➖ більше немає',
  !has(h, 'data-kind="add"') && !has(h, 'data-kind="sub"')]);
t.push(['скасування видно', has(h, 'data-kind="cancel"')]);
t.push(['доставки в самовивозі немає', !has(h, 'data-kind="ship"')]);

// 2. заборони з сервера ховають кнопки — панель не пропонує того, що відхилять
h = draw(ord({ status: 'cooking', label: 'Готується', can: { money: false, ship: false, cancel: true } }), NOW);
t.push(['після «Готується» суму не чіпаємо', !has(h, 'data-kind="fact"') && !has(h, 'data-kind="add"')]);
t.push(['скасувати ще можна', has(h, 'data-kind="cancel"')]);

h = draw(ord({ status: 'done', label: 'Видано', can: { money: false, ship: false, cancel: false } }), NOW);
t.push(['на виданому жодної дрібної дії', !has(h, 'class="more"')]);

// 3. доставка
h = draw(ord({ mode: 'delivery', addr: 'Шевченка 1', can: { money: true, ship: true, cancel: true } }), NOW);
t.push(['вартість доставки — тільки для доставки', has(h, 'data-kind="ship"')]);

// 3а. перенесення часу — лише поки не готують (сервер каже can.time)
h = draw(ord({ can: { money: true, ship: false, cancel: true, time: true } }), NOW);
t.push(['кнопка «Час» є, коли сервер дозволяє', has(h, 'data-kind="time"')]);
h = draw(ord({ status: 'cooking', label: 'Готується', can: { money: false, ship: false, cancel: true, time: false } }), NOW);
t.push(['коли готують — кнопки «Час» немає', !has(h, 'data-kind="time"')]);
{
  const days = [{ day: '2026-09-29', label: 'Сьогодні', slots: [{ at: NOW + 60 * MIN, label: '14:00' }] },
                { day: '2026-09-30', label: 'Завтра', slots: [{ at: NOW + 25 * 60 * MIN, label: '10:00', full: true },
                                                      { at: NOW + 26 * 60 * MIN, label: '11:00' }] }];
  h = draw(ord({ fry: true, fg: 1000 }), NOW, { no: 101, kind: 'time' });
  t.push(['поки слоти вантажаться — «Завантажую»', has(h, 'Завантажую')]);
  h = draw(ord({ fry: true, fg: 1000 }), NOW, { no: 101, kind: 'time', days, day: 1, at: 0 });
  t.push(['обрано день — видно його години', has(h, '>10:00<') && has(h, '>11:00<') && !has(h, '>14:00<')]);
  t.push(['дні календариком: з понеділка, чужі дні неактивні',
    has(h, '>Пн<') && (h.match(/<button disabled>/g) || []).length === 5 && /data-tday="1" class="on"/.test(h)]);
  t.push(['забита година мангала позначена', /data-tat="\d+" class="[^"]*full/.test(h)]);
  t.push(['без обраної години кнопка неактивна', /data-settime="101" disabled/.test(h)]);
  h = draw(ord(), NOW, { no: 101, kind: 'time', days, day: 1, at: NOW + 26 * 60 * MIN });
  t.push(['обрали годину — кнопка «Перенести на 11:00»', has(h, 'Перенести на 11:00') && !/data-settime="101" +disabled/.test(h)]);
}

// 3в. коли видавати — крупно, з днем: «сьогодні», «завтра», «Пт, 3.10»
h = draw(ord({ slotAt: NOW + 5 * MIN }), NOW);
t.push(['видача сьогодні — під часом «сьогодні»', /class="dw">сьогодні</.test(h) || /class="dw">завтра</.test(h)]);
h = draw(ord({ slotAt: NOW + 3 * 24 * 60 * MIN }), NOW);
t.push(['видача через 3 дні — день тижня й дата, виділено', /class="dw fut">(Нд|Пн|Вт|Ср|Чт|Пт|Сб), \d+\.\d{2}</.test(h)]);

// 3б. імʼя й телефон — великим, телефон групами цифр
h = draw(ord({ tel: '+380979705744', nm: 'Надія' }), NOW);
t.push(['телефон групами: 097 970 57 44', has(h, '<span class="ph">097 970 57 44</span>')]);
t.push(['імʼя окремим великим рядком', has(h, '<span class="nm">Надія</span>')]);

// 4. форма замість кнопок
h = draw(ord(), NOW, { no: 101, kind: 'fact' });
t.push(['відкрита форма ховає рядок кнопок', !has(h, 'class="more"') && has(h, 'class="form"')]);
t.push(['для суми — поле суми і поле коментаря', has(h, 'id="fv"') && has(h, 'id="fn"')]);
/* type="number" з комою порожніє, а на планшеті десяткова клавіша — саме кома */
t.push(['поле суми не числове, але з числовою клавіатурою',
  !has(h, 'type="number"') && has(h, 'inputmode="decimal"')]);
t.push(['кнопка надсилання підписана видом дії', has(h, 'data-send="101" data-kind="fact"')]);

h = draw(ord(), NOW, { no: 101, kind: 'cancel' });
t.push(['у скасуванні поля суми немає', !has(h, 'id="fn"') && has(h, 'type="text"')]);
t.push(['кнопка скасування названа прямо', has(h, 'Скасувати замовлення')]);

h = draw(ord({ no: 102 }), NOW, { no: 101, kind: 'fact' });
t.push(['форма відкрита лише на своїй картці', !has(h, 'class="form"') && has(h, 'class="more"')]);

// 5. старий сервер без can не ламає панель
h = draw(Object.assign(ord(), { can: undefined }), NOW);
t.push(['без can картка малюється, просто без дрібних дій', has(h, '№ 101') && !has(h, 'class="more"')]);

// 6. замовлення на інший день видно з першого погляду
h = draw(ord({ day: 'завтра', slotAt: NOW + 24 * 60 * MIN }), NOW);
t.push(['«завтра» стоїть під часом, виділено', has(h, '<span class="dw fut">завтра</span>')]);
h = draw(ord(), NOW);
t.push(['на сьогоднішньому дати немає', !has(h, '<em>')]);

// 7. головна кнопка досі на місці й блокується до свого часу
h = draw(ord({ status: 'accepted', label: 'Прийнято', startAt: NOW + 30 * MIN }), NOW);
t.push(['зарано готувати — кнопка замкнена з підписом часу', has(h, 'disabled') && has(h, 'можна з')]);

/* «Прийняти в роботу» сервер пропускає повз обидві заборони — і панель
   мусить так само, інакше замовлення на завтра неможливо взяти. */
h = draw(ord({ status: 'new', label: 'Нове', startAt: NOW + 12 * 60 * MIN, day: 'завтра' }), NOW);
t.push(['на завтра прийняти в роботу можна', has(h, 'Прийняти в роботу') && !has(h, 'disabled')]);
h = draw(ord({ status: 'new', label: 'Нове', startAt: NOW + 5 * 60 * MIN }), NOW);
t.push(['задовго до часу прийняти теж можна', has(h, 'Прийняти в роботу') && !has(h, 'disabled')]);
h = draw(ord({ status: 'accepted', label: 'Прийнято', startAt: NOW + 12 * 60 * MIN, day: 'завтра' }), NOW);
t.push(['а готувати на завтра — ні, і сказано коли', has(h, 'disabled') && has(h, 'готувати завтра')]);

// 8. купки: нове окремо, робота окремо, зроблене окремо
const groupOf = pick('groupOf');
t.push(['нове — у першу купку', groupOf({ status: 'new' }) === 0]);
t.push(['усе, що в роботі сьогодні, — у другу',
  ['accepted', 'cooking', 'ready', 'onway'].every(s => groupOf({ status: s }) === 1)]);
t.push(['прийняте на інший день — в окрему купку',
  ['accepted', 'cooking', 'ready'].every(s => groupOf({ status: s, day: 'завтра' }) === 2)]);
t.push(['а нове на інший день усе одно в «Нових» — його треба прийняти',
  groupOf({ status: 'new', day: 'завтра' }) === 0]);
t.push(['видане й скасоване — в останню',
  groupOf({ status: 'done' }) === 3 && groupOf({ status: 'canceled' }) === 3
  && groupOf({ status: 'done', day: 'завтра' }) === 3]);

/* «Зібрано» — своя купка, але не для нових, зроблених і тих, що на інший день */
t.push(['зібране сьогодні — в купку «Зібрано»',
  ['accepted', 'cooking', 'ready', 'onway'].every(s => groupOf({ status: s, packed: true }) === 4)]);
t.push(['зібране на інший день лишається в «Чекають свого дня»',
  groupOf({ status: 'accepted', packed: true, day: 'завтра' }) === 2]);
t.push(['видане зібране — у завершених', groupOf({ status: 'done', packed: true }) === 3]);

// 8а. кнопка «Зібрано» на картці — лише коли сервер дозволяє
h = draw(ord({ status: 'accepted', label: 'Прийнято', can: { money: true, cancel: true, pack: true } }), NOW);
t.push(['прийняте можна позначити зібраним',
  has(h, 'data-pack="101"') && has(h, 'data-on="1"') && has(h, '📦 Зібрано')]);
t.push(['поки не зібране — значка немає', !has(h, 'class="pk"') && !has(h, ' packed"')]);
h = draw(ord({ status: 'accepted', label: 'Прийнято', packed: true, can: { money: true, cancel: true, pack: true } }), NOW);
t.push(['зібране — значок, рамка й кнопка зняти позначку',
  has(h, 'class="pk"') && has(h, ' packed"') && has(h, 'data-on="0"') && has(h, 'Не зібрано')]);
h = draw(ord(), NOW);
t.push(['нове зібраним не позначити — кнопки немає', !has(h, 'data-pack')]);

// 8б. «Готується» можна повернути в «Прийнято», коли сервер дозволяє
h = draw(ord({ status: 'cooking', label: 'Готується', can: { cancel: true, back: true } }), NOW);
t.push(['готується — є кнопка повернути в «Прийнято»', has(h, 'data-uncook="101"')]);
h = draw(ord({ status: 'accepted', label: 'Прийнято', can: { money: true, cancel: true } }), NOW);
t.push(['прийняте — кнопки повернення немає', !has(h, 'data-uncook')]);

// 9. підсумок дня
const dayStrip = pick('dayStrip');
let s = dayStrip({ all: 7, canceled: 2, open: 3, pickup: 4, delivery: 1, ship: 0, sum: 8659.42, fg: 16400 });
t.push(['скасовані не рахуються в кількості', has(s, '<b>5</b> замовлень')]);
t.push(['сума й мангал на місці', has(s, '8659.42 ₴') && has(s, '16.4 кг')]);
t.push(['скасовані показані окремо', has(s, 'скасовано 2')]);
t.push(['порожній день — так і кажемо', has(dayStrip({ all: 0 }), 'ще не було')]);
t.push(['сервер нічого не прислав — не падаємо', has(dayStrip(null), 'ще не було')]);

report(t);
