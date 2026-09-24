/* Перевірка розмітки панелі точки на справжньому коді: вирізаємо з op.html
   card, more, formHtml і NEXT/FORM і малюємо картки на підставлених
   замовленнях. Так видно, які кнопки побачить оператор.
   Запуск: node tools/panel-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'op.html'), 'utf8');

const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли: ' + re); process.exit(1) } return m[0] };
const code = [
  cut(/const NEXT=\{[\s\S]*?\n  : NEXT\[o\.status\]\|\|null;/),
  cut(/function card\(o,now\)\{[\s\S]*?\n\}/),
  cut(/function more\(o\)\{[\s\S]*?\n\}/),
  cut(/const FORM=\{[\s\S]*?\n\};/),
  cut(/function formHtml\(o,kind\)\{[\s\S]*?\n\}/)
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
t.push(['сума, ➕, ➖, коментар видно, поки можна', ['fact', 'add', 'sub', 'note'].every(k => has(h, `data-kind="${k}"`))]);
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
h = draw(ord({ day: 'завтра' }), NOW);
t.push(['«завтра» стоїть біля часу', has(h, '<em>завтра</em>')]);
h = draw(ord(), NOW);
t.push(['на сьогоднішньому дати немає', !has(h, '<em>')]);

// 7. головна кнопка досі на місці й блокується до свого часу
h = draw(ord({ status: 'accepted', label: 'Прийнято', startAt: NOW + 30 * MIN }), NOW);
t.push(['зарано готувати — кнопка замкнена з підписом часу', has(h, 'disabled') && has(h, 'можна з')]);

let bad = 0;
for (const [name, ok] of t) { console.log((ok ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!ok) bad++ }
console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad ? 1 : 0);
