/* Перевірка голосових нагадувань панелі на справжньому коді: вирізаємо з
   op.html stuckOf і nagDue і ганяємо підставлені замовлення по часу —
   коли панель заговорить, коли змовкне і що скаже.
   Запуск: node tools/nag-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'op.html'), 'utf8');

const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли: ' + re); process.exit(1) } return m[0] };
const code = [
  cut(/const NAG_FIRST=[^\n]*/),
  cut(/const plural=[^\n]*/),
  cut(/const SAY=\{[\s\S]*?\n\};/),
  cut(/const count=[^\n]*/),
  cut(/const mins=[^\n]*/),
  cut(/function stuckOf\(o,now,L\)\{[\s\S]*?\n\}/),
  cut(/function nagDue\(orders,now,told,L\)\{[\s\S]*?\n\}/),
  cut(/function unlockDue\(orders,now,heard,L\)\{[\s\S]*?\n\}/)
].join('\n');
const api = new Function(`${code}; return { stuckOf, nagDue, unlockDue, plural }`)();

const MIN = 60000, T = Date.parse('2026-09-29T12:00:00+03:00');
const ord = o => ({ no: 57, status: 'accepted', mode: 'pickup', day: '', createdAt: T - 60 * MIN,
  slotAt: T + 60 * MIN, startAt: T, readyAt: 0, ...o });
const due = (o, now, told = {}, L = 'uk') => api.nagDue([o], now, told, L);

const t = [];
const ok = (name, cond) => t.push([name, cond]);

// ---------- коли починаємо ----------
let o = ord({ status: 'new', createdAt: T });
ok('нове: 4 хв — мовчимо', due(o, T + 4 * MIN).length === 0);
ok('нове: 5 хв — нагадуємо', due(o, T + 5 * MIN).length === 1);
ok('нове на завтра — теж нагадуємо: прийняти треба зараз', due(ord({ status: 'new', createdAt: T, day: 'завтра' }), T + 6 * MIN).length === 1);

o = ord({ status: 'accepted', startAt: T });
ok('прийняте: до часу братися — мовчимо', due(o, T - 30 * MIN).length === 0);
ok('прийняте: 5 хв після часу братися — «час починати»', /час починати/.test((due(o, T + 5 * MIN)[0] || {}).say));
ok('прийняте на інший день — мовчимо', due(ord({ day: 'завтра' }), T + 60 * MIN).length === 0);

o = ord({ status: 'cooking', slotAt: T });
ok('готується: після часу видачі — «мало бути готове»', /мало бути готове/.test((due(o, T + 6 * MIN)[0] || {}).say));

o = ord({ status: 'ready', readyAt: T, slotAt: T - 30 * MIN });
const r = due(o, T + 7 * MIN)[0] || {};
ok('готове на самовивіз: скільки хвилин і «Видано»', /7 хвилин/.test(r.say) && /Видано/.test(r.say));
o = ord({ status: 'ready', readyAt: T - 60 * MIN, slotAt: T + 3 * 60 * MIN });
ok('готове заздалегідь — рахуємо від часу видачі, людина ще не мала прийти', due(o, T).length === 0);
o = ord({ status: 'ready', mode: 'delivery', readyAt: T });
ok('готове на доставку — «передали курʼєру?»', /курʼєру/.test((due(o, T + 5 * MIN)[0] || {}).say));

ok('видане й скасоване не чіпаємо', due(ord({ status: 'done' }), T + 99 * MIN).length === 0
  && due(ord({ status: 'onway' }), T + 99 * MIN).length === 0);

// ---------- як часто ----------
o = ord({ status: 'cooking', slotAt: T });
const told = {};
let said = [];
for (let m = 0; m <= 20; m++) {
  const now = T + m * MIN;
  const d = api.nagDue([o], now, told, 'uk');
  d.forEach(x => { told[x.no] = now; said.push(m) });
}
ok('перше через 5 хв, далі кожні 5', JSON.stringify(said) === JSON.stringify([5, 10, 15, 20]));

/* Зрушили замовлення — наступний крок рахується з нуля, а не «ще 5 хв» */
o = ord({ status: 'ready', readyAt: T + 21 * MIN, slotAt: T });
ok('новий крок — знову 5 хв спокою', api.nagDue([o], T + 23 * MIN, told, 'uk').length === 0
  && api.nagDue([o], T + 26 * MIN, told, 'uk').length === 1);

// ---------- російською: у Chrome на планшеті точки є лише російський голос ----------
const say = (o, now) => (due(o, now, {}, 'ru')[0] || {}).say || '';
ok('російською: «Заказ 57 готов уже 7 минут»',
  /Заказ 57 готов уже 7 минут/.test(say(ord({ status: 'ready', readyAt: T, slotAt: T - 30 * MIN }), T + 7 * MIN)));
ok('російською: «пора начинать готовить»', /пора начинать готовить/.test(say(ord({ status: 'accepted', startAt: T }), T + 5 * MIN)));
ok('російською: «Передали курьеру?»', /курьеру/.test(say(ord({ status: 'ready', mode: 'delivery', readyAt: T }), T + 5 * MIN)));
ok('мову не вказали — російською',
  /Новый заказ/.test((api.nagDue([ord({ status: 'new', createdAt: T })], T + 6 * MIN, {})[0] || {}).say || ''));

// ---------- кнопка «Готується» ожила — одразу, один раз ----------
{
  const o = ord({ status: 'accepted', startAt: T });
  const heard = {};
  ok('до часу братися — мовчимо', api.unlockDue([o], T - MIN, heard, 'ru').length === 0);
  const first = api.unlockDue([o], T + 10000, heard, 'ru');
  ok('щойно ожила — «можно начинать готовить»', first.length === 1 && /можно начинать готовить/.test(first[0].say));
  first.forEach(x => heard[x.no] = 1);
  ok('вдруге не кажемо', api.unlockDue([o], T + 2 * MIN, heard, 'ru').length === 0);
  ok('відкрили панель через 20 хв — не «можно», а звичайне нагадування',
    api.unlockDue([o], T + 20 * MIN, {}, 'ru').length === 0 && api.nagDue([o], T + 20 * MIN, {}, 'ru').length === 1);
  ok('на інший день — мовчимо', api.unlockDue([ord({ status: 'accepted', startAt: T, day: 'завтра' })], T + 10000, {}, 'ru').length === 0);
  ok('українською — «можна починати готувати»', /можна починати/.test((api.unlockDue([o], T + 10000, {}, 'uk')[0] || {}).say || ''));
}

// ---------- слова ----------
ok('1 хвилину, 3 хвилини, 5 хвилин, 11 хвилин, 22 хвилини',
  ['хвилину', 'хвилини', 'хвилин', 'хвилин', 'хвилини'].join() ===
  [1, 3, 5, 11, 22].map(n => api.plural(n, 'хвилину', 'хвилини', 'хвилин')).join());

let bad = 0;
for (const [name, good] of t) { console.log((good ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!good) bad++ }
console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad ? 1 : 0);
