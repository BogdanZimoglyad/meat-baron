/* Сторінки товарів для превʼю посилань.
   Запуск: node tools/pages.js

   Навіщо. Сайт односторінковий, і будь-яке посилання виглядало в
   Telegram однаково: логотип і «Мʼясний Барон». Месенджери не виконують
   скрипти — вони читають теги на початку сторінки. Тож на кожен товар
   робимо крихітну сторінку в теці t/: у ній теги з назвою, ціною і фото,
   а людину вона одразу переставляє на сайт із відкритою карткою.

   Прайс беремо з catalog.js, описи й фото — з index.html: вони живуть
   там, і другої копії заводити не будемо, бо копії розходяться. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SITE = 'https://meat-baron.kh.ua';
const OUT = path.join(root, 't');

const CAT = require(path.join(root, 'catalog.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const grab = (name, re) => {
  const m = html.match(re);
  if (!m) { console.error(`Не знайшли ${name} в index.html — розмітка змінилась?`); process.exit(1) }
  return new Function(`${m[0]}; return ${name}`)();
};
const DESC = grab('DESC', /const DESC=\{[\s\S]*?\n\};/);
const PHOTO = grab('PHOTO', /const PHOTO=\{[\s\S]*?\n\};/);

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => CAT.kop(n).toFixed(2).replace(/\.00$/, '') + ' ₴';

/* «36.19 ₴ за 100 г», «39 ₴ за порцію», «13.90 ₴ за 100 г · упаковка 1 кг» */
function priceLine(it) {
  if (CAT.variantsOf(it)) return `${CAT.variantsOf(it).list.length} видів на вибір`;
  if (it.unit === 'шт') {
    const u = CAT.countUnitOf(it);
    return `${money(it.price)} за ${u ? u.za : 'штуку'}`;
  }
  if (it.unit === 'пак') return `${money(it.price)} за 100 г · упаковка ${CAT.packLabel(it)}`;
  return `${money(it.price)} за 100 г`;
}

const page = it => {
  const photo = PHOTO[it.grp + '/' + it.name] || PHOTO[it.name];
  const img = photo ? `${SITE}/photo/${photo}` : `${SITE}/logo-square.png`;
  const desc = DESC[it.grp + '/' + it.name] || DESC[it.name] || '';
  const title = `${CAT.nameOf(it)} — ${priceLine(it)}`;
  const text = (desc || 'Свіже мясо, ковбаски власного виробництва та мясо зі смокеру.').slice(0, 300);
  const to = `/?item=${it.id}`;
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Мʼясний Барон</title>
<meta name="description" content="${esc(text)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Мʼясний Барон">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(text)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${SITE}/t/${it.id}.html">
<meta name="twitter:card" content="summary_large_image">
${/* canonical — на саму себе. Коли він вів на «?item=…», Telegram
     сприймав це як «справжня сторінка там», ішов на головну й брав її
     теги: у превʼю замість фото товару був логотип (перевірено 22.09). */''}
<link rel="canonical" href="${SITE}/t/${it.id}.html">
<link rel="icon" href="/icon-192.png">
${/* Переставляємо лише скриптом. З <meta http-equiv="refresh"> Telegram
     ішов за перенаправленням на головну, читав теги вже там — і показував
     голе посилання замість картки (перевірено в бою 22.09). Скрипт
     краулери не виконують, тож теги вище дістаються саме їм. */''}
<script>location.replace('${to}')</script>
<style>body{margin:0;background:#141010;color:#f0e9de;font:16px/1.5 system-ui,sans-serif;
display:grid;place-items:center;min-height:100vh;text-align:center}a{color:#e04a3c}</style>
</head>
<body>
<div>
  <p>${esc(CAT.nameOf(it))} — ${esc(priceLine(it))}</p>
  <p><a href="${to}">Відкрити в каталозі «Мʼясного Барона»</a></p>
</div>
</body>
</html>
`;
};

/* Заразом проставляємо версію прайсу в index.html: сторінка має тягнути
   саме той catalog.js, з яким її зібрано. Без цього в телефоні
   змішувались свіжа розмітка і старий прайс із кеша — і каталог не
   малювався взагалі (власник, 23.09). */
(function stampCatalogVersion() {
  const v = require('crypto').createHash('md5')
    .update(fs.readFileSync(path.join(root, 'catalog.js'))).digest('hex').slice(0, 8);
  /* op.html теж тягне прайс — назви позицій для стоп-листа точки */
  for (const name of ['index.html', 'op.html']) {
    const file = path.join(root, name);
    const was = fs.readFileSync(file, 'utf8');
    const now = was.replace(/<script src="catalog\.js(\?v=[a-f0-9]+)?"><\/script>/,
      `<script src="catalog.js?v=${v}"></script>`);
    if (now !== was) { fs.writeFileSync(file, now); console.log(`Версію прайсу в ${name} оновлено: ${v}`) }
  }
})();

fs.mkdirSync(OUT, { recursive: true });
/* Прибираємо старі: позицію могли перейменувати або зняти з продажу,
   і її сторінка вела б у нікуди. */
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.html')) fs.unlinkSync(path.join(OUT, f));

let withPhoto = 0;
for (const it of CAT.ITEMS) {
  fs.writeFileSync(path.join(OUT, it.id + '.html'), page(it));
  if (PHOTO[it.grp + '/' + it.name] || PHOTO[it.name]) withPhoto++;
}
console.log(`Готово: ${CAT.ITEMS.length} сторінок у t/ (з фото — ${withPhoto}, решта з логотипом).`);
console.log('Після зміни прайсу, описів чи фото — запустіть ще раз.');
