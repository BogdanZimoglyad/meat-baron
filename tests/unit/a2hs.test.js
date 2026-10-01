/* Перевірка того, кому і коли показується підказка «Додайте на екран».
   Вигляд видно в браузері, а от правила показу — ні: на столі немає ні
   айфона, ні standalone, ні другого заходу. Тож вирізаємо блок із
   index.html і ганяємо на підставленому оточенні.
   Запуск: npm test */
const fs = require('fs');
const report = require('../report.js');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

const m = html.match(/\/\* ---------- «Додайте на екран» для айфонів[\s\S]*?\n\}\)\(\);/);
if (!m) { throw new Error('не знайшли блок підказки в index.html') }
const code = m[0];

const UA = {
  'iPhone Safari': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  'iPhone Chrome': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/128.0 Mobile/15E148 Safari/604.1',
  'Android Chrome': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36',
  'Windows Chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36'
};

/* Проганяємо блок і кажемо, чи зʼявився баннер. Таймери виконуємо одразу:
   нас цікавить рішення, а не через скільки секунд воно настане. */
function run({ ua, standalone = false, store = {}, sheetOpen = false, noStorage = false }) {
  let shown = 0;
  const body = { appendChild: () => { shown++ } };
  const el = () => ({ className: '', innerHTML: '', remove() {}, querySelector: () => ({ set onclick(v) {} }) });
  const env = {
    window: { visualViewport: null },      // журнал ?debug=1 у тесті не потрібен
    navigator: { userAgent: ua, standalone: standalone || undefined },
    matchMedia: q => ({ matches: standalone && /standalone/.test(q) }),
    localStorage: noStorage
      ? { getItem() { throw new Error('вимкнено') }, setItem() { throw new Error('вимкнено') } }
      : { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) } },
    document: {
      body,
      createElement: el,
      querySelector: sel => (sel === '.sheet.on' ? (sheetOpen ? {} : null) : null)
    },
    setTimeout: fn => fn(),
    setInterval: fn => { fn(); return 1 },
    clearInterval: () => {}
  };
  new Function(...Object.keys(env), code)(...Object.values(env));
  return { shown: shown > 0, store };
}

const t = [];
const ok = (name, cond) => t.push([name, cond]);

// ---------- кому ----------
ok('айфон у Safari, другий захід — показуємо',
  run({ ua: UA['iPhone Safari'], store: { 'mb-visits': '1' } }).shown);
ok('айфон у Chrome — мовчимо, там кроки інші',
  !run({ ua: UA['iPhone Chrome'], store: { 'mb-visits': '1' } }).shown);
ok('андроїд — мовчимо, у нього свій баннер',
  !run({ ua: UA['Android Chrome'], store: { 'mb-visits': '1' } }).shown);
ok('компʼютер — мовчимо',
  !run({ ua: UA['Windows Chrome'], store: { 'mb-visits': '1' } }).shown);
ok('уже стоїть на екрані (navigator.standalone) — мовчимо',
  !run({ ua: UA['iPhone Safari'], standalone: true, store: { 'mb-visits': '1' } }).shown);

// ---------- коли ----------
ok('перший захід — не ліземо',
  !run({ ua: UA['iPhone Safari'], store: {} }).shown);
ok('уже закрив раніше — більше ніколи',
  !run({ ua: UA['iPhone Safari'], store: { 'mb-visits': '5', 'mb-a2hs-off': '1' } }).shown);
ok('поки відкрита шторка — чекаємо, не перебиваємо',
  !run({ ua: UA['iPhone Safari'], store: { 'mb-visits': '1' }, sheetOpen: true }).shown);

// ---------- лічильник заходів ----------
let s = {};
run({ ua: UA['iPhone Safari'], store: s });
ok('перший захід записався', s['mb-visits'] === '1');
run({ ua: UA['iPhone Safari'], store: s });
ok('другий захід порахувався', s['mb-visits'] === '2');
ok('лічильник росте й на андроїді? — ні, до нього діло не доходить',
  run({ ua: UA['Android Chrome'], store: {} }).store['mb-visits'] === undefined);

// ---------- памʼять вимкнена ----------
ok('у приватному режимі без памʼяті не падаємо й не показуємо',
  !run({ ua: UA['iPhone Safari'], noStorage: true }).shown);

report(t);
