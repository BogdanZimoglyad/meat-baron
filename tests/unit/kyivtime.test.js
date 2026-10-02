/* Сайт рахує години за Києвом, хай який пояс стоїть на телефоні
   (власник, 02.10: телефон клієнта на годину відставав, і «17:00» на
   сайті ставало 18:00 у панелі). Вирізаємо з index.html київські
   помічники, вибір часу й рядок часу і проганяємо їх у чужих поясах.
   Запуск: npm test */
const fs = require('fs');
const report = require('../report.js');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

const cut = re => { const m = src.match(re); if (!m) { throw new Error('не знайшли: ' + re) } return m[0] };
const code = [
  cut(/const KYIV_TZ=[\s\S]*?const hhmmK=[^\n]*/),
  cut(/function dayKey\(d\)\{[^\n]*/),
  cut(/function dayLabel\(d\)\{[\s\S]*?\n\}/),
  cut(/const slotMs=[^\n]*/),
  cut(/function whenText\(o\)\{[\s\S]*?\n\}/)
].join('\n');
const DAY_NAMES = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MON = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const load = () => new Function('DAY_NAMES', 'MON',
  `${code}; return { toK, fromK, kNow, hhmmK, dayKey, dayLabel, slotMs, whenText }`)(DAY_NAMES, MON);
const kyiv = ms => new Date(ms).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });

const t = [];
const ok = (name, cond) => t.push([name, cond]);
const was = process.env.TZ;
try {
  for (const tz of ['Europe/Kyiv', 'Europe/Warsaw', 'Europe/London', 'America/New_York', 'Asia/Tokyo']) {
    process.env.TZ = tz;
    const k = load();
    /* 17:00 завтра за Києвом — так, як його будує вибір часу на сайті */
    const day = k.kNow(); day.setDate(day.getDate() + 1); day.setHours(0, 0, 0, 0);
    const slot = k.fromK(k.slotMs(day, 17));
    ok(`${tz}: обрали 17:00 — на сервер іде 17:00 за Києвом`, kyiv(slot) === '17:00');
    ok(`${tz}: туди й назад без зсуву`, k.fromK(k.toK(slot)) === slot);
    ok(`${tz}: час на сторінці — київський`, k.hhmmK(slot) === '17:00');
    ok(`${tz}: рядок часу — «Завтра · о 17:00»`,
      k.whenText({ mode: 'pickup', slotAt: slot, when: 'Сьогодні · о 16:00' }) === 'Завтра · о 17:00');
    ok(`${tz}: «зараз» — київська година`,
      k.kNow().getHours() === +new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour: 'numeric', hourCycle: 'h23' }));
  }
} finally {
  if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
}
report(t);
