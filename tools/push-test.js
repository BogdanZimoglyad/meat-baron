/* Перевірка сповіщень у браузер на справжньому коді: вирізаємо з
   server.js роботу зі списком підписок і тексти, і ганяємо на
   підставленій базі. Головне тут — щоб на один номер не копичились
   підписки й щоб протухлі зникали.
   Запуск: node tools/push-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const cut = re => { const m = src.match(re); if (!m) { console.error('не знайшли: ' + re); process.exit(1) } return m[0] };
const code = [
  cut(/const PUSH_MAX_DEVICES = 5;[\s\S]*?\n\}/),
  cut(/const NOTE_TITLE = \{[\s\S]*?\n\};/),
  cut(/const pushText = \(o, st\) => \{[\s\S]*?\n\};/),
  cut(/async function pushTo\(telKey, title, body, url\) \{[\s\S]*?\n\}/)
].join('\n');

/* Замість справжньої відправки — журнал: що пішло і куди. Одна адреса
   вдає протухлу, щоб побачити, чи прибирає її сервер. */
const build = (db, { deadEndpoint } = {}) => {
  const log = [];
  const env = {
    db,
    save: () => {},
    console: { warn: () => {}, log: () => {} },
    webpush: {
      setVapidDetails: () => {},
      generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
      sendNotification: async (s) => {
        if (s.endpoint === deadEndpoint) { const e = new Error('gone'); e.statusCode = 410; throw e }
        log.push(s.endpoint);
      }
    },
    pushKeys: () => ({ publicKey: 'pub' })
  };
  const fn = new Function(...Object.keys(env),
    `${code}; return { addPushSub, pushTo, pushText, NOTE_TITLE }`);
  return { ...fn(...Object.values(env)), log };
};

const sub = (n) => ({ endpoint: 'https://push.example/' + n, keys: { p256dh: 'k' + n, auth: 'a' + n } });
const t = [];
const ok = (name, cond) => t.push([name, cond]);

// ---------- список пристроїв ----------
let db = { push: {} };
let s = build(db);
s.addPushSub('+380670000000', sub(1));
ok('перша підписка лягла', db.push['+380670000000'].length === 1);

s.addPushSub('+380670000000', sub(1));
ok('та сама адреса не дублюється', db.push['+380670000000'].length === 1);

s.addPushSub('+380670000000', sub(2));
ok('другий пристрій додається окремо', db.push['+380670000000'].length === 2);

for (let i = 3; i <= 9; i++) s.addPushSub('+380670000000', sub(i));
ok('більше пʼяти пристроїв не тримаємо', db.push['+380670000000'].length === 5);
ok('лишились найсвіжіші', db.push['+380670000000'].map(x => x.endpoint).includes('https://push.example/9')
  && !db.push['+380670000000'].map(x => x.endpoint).includes('https://push.example/1'));

s.addPushSub('+380509999999', sub(1));
ok('чужий номер має свій список', db.push['+380509999999'].length === 1
  && db.push['+380670000000'].length === 5);

// ---------- відправка ----------
(async () => {
  db = { push: { '+380670000000': [sub(1), sub(2)] } };
  s = build(db);
  let sent = await s.pushTo('+380670000000', 'Готове', '№ 5', 'https://site/?order=5');
  ok('шлемо на всі пристрої номера', sent === true && s.log.length === 2);

  db = { push: {} };
  s = build(db);
  sent = await s.pushTo('+380670000000', 'Готове', '№ 5', '');
  ok('немає підписок — просто нічого не робимо', sent === false && s.log.length === 0);

  /* Браузер видалив підписку або людина знесла сайт з екрана: сервер
     має прибрати таку адресу, інакше вона висітиме вічно. */
  db = { push: { '+380670000000': [sub(1), sub(2)] } };
  s = build(db, { deadEndpoint: 'https://push.example/1' });
  sent = await s.pushTo('+380670000000', 'Готове', '№ 5', '');
  ok('живий пристрій отримав', sent === true && s.log.length === 1);
  ok('протухла адреса прибрана', db.push['+380670000000'].length === 1
    && db.push['+380670000000'][0].endpoint === 'https://push.example/2');

  // ---------- тексти ----------
  const o = { no: 77, mode: 'pickup', shopName: 'вул. Шевченка 142а', when: 'сьогодні, 17:30' };
  ok('у заголовку сказано, що сталось', s.NOTE_TITLE.ready.includes('готове'));
  ok('у тексті є номер і адреса', s.pushText(o, 'ready').includes('№ 77')
    && s.pushText(o, 'ready').includes('Шевченка'));
  ok('доставці пишемо про курʼєра, а не адресу точки',
    s.pushText({ ...o, mode: 'delivery' }, 'ready').includes('курʼєр'));
  ok('у прийнятому — орієнтовний час', s.pushText(o, 'accepted').includes('17:30'));

  let bad = 0;
  for (const [name, good] of t) { console.log((good ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!good) bad++ }
  console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
  process.exit(bad ? 1 : 0);
})();
