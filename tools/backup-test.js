/* Перевірка щоденної копії бази: вирізаємо backupSweep із server.js і
   ганяємо з підставленим годинником. Запуск: node tools/backup-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли ' + re); process.exit(1) } return m[0] };
const code = cut(/function backupSweep\(\) \{[\s\S]*?\n\}/);

const run = ({ owner = 777, hour = 22, sentDay = '', failSend = false }) => {
  const sent = [];
  const day = new Date().toLocaleDateString('sv-SE');
  const env = {
    OWNER_ID: owner,
    BACKUP_HOUR: 21,
    db: { backupSent: sentDay, orders: {}, users: {} },
    kyivNow: () => { const d = new Date(); d.setHours(hour, 15, 0, 0); return d },
    kyivDate: () => day,
    save: () => {},
    console: { warn: () => {} },
    sendBackup: to => { sent.push(to); return failSend ? Promise.reject(new Error('нема звʼязку')) : Promise.resolve() }
  };
  const fn = new Function(...Object.keys(env), `${code}; return backupSweep()`);
  fn(...Object.values(env));
  return { sent, db: env.db, day };
};

const t = [];
t.push(['о 22:15 копія йде власнику', run({}).sent.length === 1]);
t.push(['вдень (14:00) ще рано', run({ hour: 14 }).sent.length === 0]);
t.push(['сьогодні вже слали — не дублюємо',
  run({ sentDay: new Date().toLocaleDateString('sv-SE') }).sent.length === 0]);
t.push(['без OWNER_ID мовчимо', run({ owner: 0 }).sent.length === 0]);
t.push(['після відправки день записано', run({}).db.backupSent === run({}).day]);

/* якщо не надіслалось — прапорець скидається, щоб спробувати ще */
const bad = run({ failSend: true });
setTimeout(() => {
  t.push(['невдала відправка — спробуємо ще раз', bad.db.backupSent === '']);
  let n = 0;
  for (const [name, ok] of t) { console.log((ok ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!ok) n++ }
  console.log(n ? `\n${n} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
  process.exit(n ? 1 : 0);
}, 30);
