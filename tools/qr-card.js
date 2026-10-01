/* Табличка A6 на касу з QR (власник, 01.10): «Замовляйте без дзвінка».
   У кожної точки свій QR — ?from=qr<N>, де N — місце точки в SHOPS_ALL;
   на сторінці статистики він видно окремим рядком «QR на касі · <точка>».
   Робить print/qr-<N>.html і print/qr-<N>.pdf (через Edge). Папка print/
   у git не йде: це файли на друк, не сайт.
   Запуск:  npm i --no-save qrcode   (раз)
            node tools/qr-card.js 3          — Шевченка 142а */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const QR = require('qrcode');
const { SHOPS_ALL } = require('../catalog.js');

const n = Number(process.argv[2]);
const shop = SHOPS_ALL[n];
if (!shop) { console.error('Номер точки 0…' + (SHOPS_ALL.length - 1) + ':\n' + SHOPS_ALL.map((s, i) => `  ${i} — ${s[0]}`).join('\n')); process.exit(1) }

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'print');
const url = `https://meat-baron.kh.ua/?from=qr${n}`;
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'logo-square.png')).toString('base64');

(async () => {
  /* H — найвища стійкість: табличку затирають руками й заливає жиром */
  const qr = await QR.toString(url, { type: 'svg', errorCorrectionLevel: 'H', margin: 0, color: { dark: '#141010', light: '#ffffff' } });
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<title>QR на касу — ${shop[0]}</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600&family=Manrope:wght@500;600&display=swap" rel="stylesheet">
<style>
@page{size:105mm 148mm;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:105mm;height:148mm;background:#fff;color:#141010;-webkit-print-color-adjust:exact;print-color-adjust:exact}
/* рамка з відступом 5 мм: край аркуша принтер не друкує */
.page{width:105mm;height:148mm;padding:5mm}
.card{height:100%;padding:5mm 6mm 4mm;display:flex;flex-direction:column;align-items:center;text-align:center;
  border:.6mm solid #C4342A;border-radius:4mm}
.card>*{flex-shrink:0}
.logo{width:19mm;height:19mm;border-radius:50%;overflow:hidden}
.logo img{width:100%;height:100%;display:block;transform:scale(1.04)}
.brand{font:600 4.2mm/1 Oswald,sans-serif;letter-spacing:.6mm;text-transform:uppercase;margin-top:2.2mm}
h1{font:600 8.6mm/1.02 Oswald,sans-serif;text-transform:uppercase;margin-top:3.5mm;letter-spacing:.2mm}
h1 b{color:#C4342A;font-weight:600}
.sub{font:500 3.6mm/1.35 Manrope,sans-serif;color:#3a3230;margin-top:2.5mm}
.qr{width:48mm;height:48mm;margin-top:4mm}
.qr svg{width:100%;height:100%;display:block}
.url{font:500 5.4mm/1 Oswald,sans-serif;color:#C4342A;margin-top:3.5mm;letter-spacing:.2mm}
.foot{margin-top:auto;font:500 3mm/1.4 Manrope,sans-serif;color:#6b625e}
</style></head><body><div class="page"><div class="card">
<div class="logo"><img src="${logo}" alt=""></div>
<div class="brand">Мʼясний Барон</div>
<h1>Замовляйте<br><b>без дзвінка</b></h1>
<p class="sub">Наведіть камеру телефона на код —<br>видно ціни, мангал і час видачі</p>
<div class="qr">${qr}</div>
<div class="url">meat-baron.kh.ua</div>
<p class="foot">Шашлик на мангалі · сире мʼясо · доставка<br>${shop[0]}</p>
</div></div></body></html>`;
  fs.mkdirSync(OUT, { recursive: true });
  const htmlPath = path.join(OUT, `qr-${n}.html`), pdfPath = path.join(OUT, `qr-${n}.pdf`);
  fs.writeFileSync(htmlPath, html);
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
  if (!edge) { console.log('Edge не знайдено — відкрийте ' + htmlPath + ' і друкуйте з браузера (A6, без полів)'); return }
  execFileSync(edge, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=8000',
    '--print-to-pdf=' + pdfPath, 'file:///' + htmlPath.replace(/\\/g, '/')], { stdio: 'ignore' });
  console.log(`Готово: ${pdfPath}\nQR веде на ${url}`);
})();
