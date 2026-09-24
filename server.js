/**
 * Мʼясний Барон — сервер прийому замовлень + Telegram-бот
 *
 * Запуск:
 *   npm init -y
 *   npm i express node-telegram-bot-api cors
 *   node server.js
 *
 * Змінні оточення (.env або налаштування хостингу):
 *   BOT_TOKEN  — токен від @BotFather
 *   BIND_CODE  — пароль для команди /bind. Без нього прив'язати чат
 *                до точки не можна: інакше замовлення забере чужий чат
 *   PORT       — порт (за замовчуванням 3000)
 *   DATA_DIR   — тека для бази замовлень (на Railway — /data)
 *   CHAT_1…N   — ID чатів точок, щоб прив'язки пережили перезапуск
 */

const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Прайс, правила рахунку і список точок — той самий файл, що підключає
   сайт. Сервер не вірить ні сумі, ні назві точки з браузера. */
const CATALOG = require('./catalog.js');
const { FRY_RATE, MIN_G, kop, lineSum, fryableG, canFry, countUnitOf, variantsOf, priceOf, lineTitle, packLabel, portionOf, nameOf } = CATALOG;
const CATALOG_SHOPS = CATALOG.SHOPS;
const byId = new Map(CATALOG.ITEMS.map(it => [it.id, it]));

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Немає BOT_TOKEN. Отримайте токен у @BotFather і додайте у змінні оточення.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

/* ---------- сайт ---------- */
/* Сайт лежить у корені репозиторію — рівно ті самі файли, що віддає
   GitHub Pages. Другої копії немає, тому версії не розходяться.
   Службові файли назовні не пускаємо. */
const PRIVATE = new Set([
  'server.js', 'package.json', 'package-lock.json',
  'readme.md', 'data', 'node_modules', 'tools'
]);
app.use((req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch (e) {}
  const first = p.split('/').filter(Boolean)[0];
  if (first && PRIVATE.has(first.toLowerCase())) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, { dotfiles: 'ignore' }));

/* ---------- зберігання ---------- */
/* Дані зберігаємо на постійному диску, якщо він підключений.
   На Railway: Settings → Volumes → Mount path /data, і змінна DATA_DIR=/data.
   Без диска файл лягає в теку data/ поруч із кодом — вона закрита від
   браузера і не потрапляє в git, тож телефони клієнтів не витечуть. */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB = path.join(DATA_DIR, 'data.json');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
let db = { orders: {}, shops: {}, counter: 1000, users: {}, tokens: {}, busy: {}, extra: {}, daySent: {}, stop: {} };
try {
  db = JSON.parse(fs.readFileSync(DB, 'utf8'));
} catch (e) {
  /* Файлу немає — перший запуск, усе гаразд. А от зіпсований файл
     не можна мовчки замінити порожньою базою: перший же запис затер би
     його назавжди разом із замовленнями й покупцями, а номери пішли б
     знову з 1001. Відкладаємо копію, щоб дані можна було підняти. */
  if (e.code !== 'ENOENT') {
    const keep = DB.replace(/\.json$/, '') + '.broken-' + Date.now() + '.json';
    try { fs.copyFileSync(DB, keep); } catch (err) {}
    console.error('!!! База не читається (' + e.message + '). Копію збережено:', keep,
                  '— починаємо з порожньої. Відновіть дані з копії.');
  }
}
/* Стара база нічого не знала про покупців: дописуємо теки, щоб код
   нижче не перевіряв їхню наявність на кожному рядку. */
db.users = db.users || {};
db.tokens = db.tokens || {};

/* Пишемо в сусідній файл і підміняємо одним кроком. Раніше файл
   переписувався поверх: якщо сервер вимикали посеред запису, лишався
   обрізаний JSON — і після перезапуску база була порожня. Перейменування
   атомарне: на диску завжди або стара версія, або нова, цілком. */
const writeNow = () => {
  const tmp = DB + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB);
  } catch (e) {
    console.error('Не вдалося записати базу:', e.message);
  }
};

/* Кожен запис — це перезапис усього файлу. Оператор може натиснути
   три кнопки поспіль, тож збираємо їх в один запис. */
let saveTimer = null;
const save = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 400);
};
/* Аварійне завершення не повинно з'їдати останні кілька секунд. */
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
  if (saveTimer) { clearTimeout(saveTimer); writeNow(); }
  process.exit(0);
}));

/* Замовлення старші за пів року нікому не потрібні: історія й так
   показує лише 60 днів. Без чистки база росла б вічно, а кожен запит
   історії перебирає її цілком. */
const KEEP_DAYS = 180;
const TOKEN_TTL = 180 * 24 * 3600 * 1000;   // скільки живе вхід на пристрої
function prune() {
  const edge = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  let gone = 0;
  for (const [no, o] of Object.entries(db.orders)) {
    if ((o.createdAt || 0) < edge) { delete db.orders[no]; gone++; }
  }
  /* Протухлі ключі входу теж прибираємо: інакше файл ріс би вічно, а
     кожен запит із токеном перебирає цю теку. */
  const tEdge = Date.now() - TOKEN_TTL;
  for (const [t, rec] of Object.entries(db.tokens)) {
    if ((rec.at || 0) < tEdge) { delete db.tokens[t]; gone++; }
  }
  if (gone) { console.log('Прибрано старих записів:', gone); writeNow(); }
}
prune();
setInterval(prune, 24 * 3600 * 1000).unref();

/* Прив'язки чатів беремо зі змінних оточення CHAT_1, CHAT_2, …
   Диск на хостингу очищується при кожному перезапуску, а змінні — ні.
   Тому після /bind збережіть виданий ID у змінних проєкту. */
for (let i = 1; i <= 20; i++) {
  const v = process.env['CHAT_' + i];
  if (v) db.shops[i - 1] = Number(v);
}

/* ---------- точки ---------- */
/* Список один на два боки — у catalog.js. Раніше він жив і тут, і в
   index.html, причому по-різному: там прапорець, тут закоментовані
   рядки. Розійшлися б — і замовлення поїхало б не на ту точку.
   Щоб увімкнути точку, постав 1 у третьому стовпці в catalog.js. */
const SHOPS = CATALOG_SHOPS.map(s => s[0]);

/* Прив'язка точки, яку вимкнули в catalog.js, лишалась у базі й жила
   власним життям: підсумок дня приходив двічі, причому вдруге — без
   назви точки, бо її вже немає в списку (власник побачив 23.09, коли
   лишили саму Шевченка). Прибираємо все, що дивиться за межі списку. */
(function dropStaleShops() {
  const stale = Object.keys(db.shops).filter(k => Number(k) >= SHOPS.length);
  if (!stale.length) return;
  for (const k of stale) delete db.shops[k];
  writeNow();
  console.log('Прибрано прив’язки вимкнених точок:', stale.join(', '));
})();

/* Дорога замовлення. «У дорозі» буває лише на доставці — після «Готове»
   оператор передає пакунок таксі; на самовивозі цього кроку немає.
   «Скасовано» стоїть осібно: воно не крок уперед, а вихід із ланцюжка. */
const STATUSES = ['new', 'accepted', 'cooking', 'ready', 'onway', 'done'];
const CANCELED = 'canceled';
const FINAL = new Set(['done', CANCELED]);
const LABEL = {
  new: 'Нове',
  accepted: 'Прийнято',
  cooking: 'Готується',
  ready: 'Готове',
  onway: 'У дорозі',
  done: 'Видано',
  canceled: 'Скасовано'
};
/* Кнопки залежать від способу отримання, тому це функція, а не таблиця */
const nextBtns = o =>
    o.status === 'new'      ? [['accepted', '✅ Прийняти в роботу']]
  : o.status === 'accepted' ? [['cooking', '👨‍🍳 Готується']]   // 🔥 тепер у «Готове», як на сайті
  : o.status === 'cooking'  ? [['ready', '🔥 Готове']]
  : o.status === 'ready'    ? (o.mode === 'delivery' ? [['onway', '🚗 Передали курʼєру']] : [['done', '🤝 Видано']])
  : o.status === 'onway'    ? [['done', '🤝 Доставлено']]
  : [];

const money = n => kop(n).toFixed(2).replace(/\.00$/, '') + ' ₴';
const normTel = t => {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('380')) d = d.slice(3);
  else if (d.startsWith('80')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d.slice(0, 9);
};
/* У логи Railway телефон повністю не пишемо: доступ до логів має
   не лише той, хто його дав нам (власник питав про захист 23.09). */
const telLog = t => String(t || '').replace(/^(\+380\d{2})\d{3}(\d{2})(\d{2})$/, '$1***$2$3');
const esc = t => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* 2.55 кг, а не 2.5: оператор має бачити точну вагу, крок на сайті — 50 г */
const wLabel = g => (g >= 1000 ? (g / 1000).toFixed(g % 100 ? 2 : g % 1000 ? 1 : 0) + ' кг' : g + ' г');

/* ---------- вхід покупця через Telegram ----------
   Номер не питаємо текстом і нікуди не надсилаємо код. Сайт відкриває
   бота з разовим ключем, людина тисне «Поділитися номером», і номер
   приходить від самого Telegram. Введений руками номер нічого не
   доводить: за ним можна було б забрати чужу історію замовлень.  */
const AUTH_TTL = 5 * 60 * 1000;        // скільки живе спроба входу
const logins = new Map();              // ключ входу → стан спроби
const chatLogin = new Map();           // чат у Telegram → ключ входу

let BOT_NAME = process.env.BOT_USERNAME || '';
let BOT_ID = 0;                          // щоб упізнавати відповіді на власні запити бота
bot.getMe()
  .then(me => { BOT_NAME = me.username || BOT_NAME; BOT_ID = me.id; console.log('Бот @' + BOT_NAME); })
  .catch(e => console.warn('Не вдалося дізнатися імʼя бота:', e.message));

/* Спроби входу живуть у памʼяті: вони потрібні хвилину-дві, а після
   перезапуску сервера людина просто натисне «Увійти» ще раз. */
function sweepLogins() {
  const now = Date.now();
  for (const [sid, s] of logins) {
    if (now - s.at > AUTH_TTL) { logins.delete(sid); if (s.chatId) chatLogin.delete(s.chatId); }
  }
}
setInterval(sweepLogins, 60 * 1000).unref();

function issueToken(telKey) {
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = { telKey, at: Date.now() };
  return token;
}
/* Хто прийшов із цим токеном. null — значить ніхто. */
function authOf(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const rec = db.tokens[token];
  if (!rec) return null;
  if (Date.now() - (rec.at || 0) > TOKEN_TTL) { delete db.tokens[token]; save(); return null; }
  const user = db.users[rec.telKey] || { telKey: rec.telKey };
  return { token, telKey: rec.telKey, user };
}

/* ---------- прив'язка чату до точки ---------- */
/* Один обробник на дві різні речі: у приватному чаті з ключем це вхід
   покупця, в усьому іншому — підказка операторові. */
bot.onText(/^\/(start|help)(?:\s+(\S+))?/, (msg, m) => {
  const sid = m[2] || '';
  const isPrivate = msg.chat && msg.chat.type === 'private';
  const login = sid && logins.get(sid);

  if (isPrivate && sid) {
    if (!login || Date.now() - login.at > AUTH_TTL) {
      return bot.sendMessage(msg.chat.id,
        'Посилання застаріло. Поверніться на сайт і натисніть «Увійти» ще раз.');
    }
    login.chatId = msg.chat.id;
    chatLogin.set(msg.chat.id, sid);
    return bot.sendMessage(msg.chat.id,
      'Вітаємо в «Мʼясному Бароні».\n\n' +
      'Натисніть кнопку нижче — і ми впізнаємо вас на сайті. ' +
      'Номер надішле сам Telegram, вводити нічого не треба.',
      {
        reply_markup: {
          keyboard: [[{ text: '📱 Поділитися номером', request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true
        }
      });
  }

  /* Покупець, який відкрив бота сам, без посилання з сайту: пояснюємо
     по-людськи. Раніше він бачив інструкцію для операторів. */
  if (isPrivate) {
    return bot.sendMessage(msg.chat.id,
      'Це бот «Мʼясного Барона».\n\n' +
      'Щоб увійти на сайті, натисніть там «Увійти» — і бот сам запропонує ' +
      'поділитися номером. Замовлення приймає сайт, тут вони не оформлюються.\n\n' +
      'Операторам точок: /bind НОМЕР КОД');
  }
  bot.sendMessage(msg.chat.id,
    'Бот прийому замовлень «Мʼясний Барон».\n\n' +
    'Щоб цей чат отримував замовлення певної точки, надішліть:\n' +
    '/bind НОМЕР КОД\n\n' +
    'Список точок — /points\n' +
    'Поточна прив’язка — /whoami');
});

/* Номер від Telegram. Перевіряємо, що це контакт самого відправника:
   картку чужого контакту можна переслати боту, і без цієї перевірки
   нею забрали б чужий обліковий запис. */
bot.on('contact', msg => {
  const c = msg.contact || {};
  if (!msg.chat || msg.chat.type !== 'private') return;
  if (!c.user_id || !msg.from || c.user_id !== msg.from.id) {
    return bot.sendMessage(msg.chat.id,
      'Це чужий контакт. Натисніть кнопку «Поділитися номером» — Telegram надішле ваш власний.',
      { reply_markup: { remove_keyboard: true } });
  }
  const telKey = normTel(c.phone_number);
  if (telKey.length !== 9) {
    return bot.sendMessage(msg.chat.id, 'Не вдалося розібрати номер. Напишіть операторові.',
      { reply_markup: { remove_keyboard: true } });
  }

  const sid = chatLogin.get(msg.chat.id);
  const login = sid && logins.get(sid);
  if (!login || Date.now() - login.at > AUTH_TTL) {
    return bot.sendMessage(msg.chat.id,
      'Спроба входу застаріла. Поверніться на сайт і натисніть «Увійти» ще раз.',
      { reply_markup: { remove_keyboard: true } });
  }

  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').slice(0, 60);
  const u = db.users[telKey] || { telKey, createdAt: Date.now() };
  u.tel = '+380' + telKey;
  u.tgId = msg.from.id;
  if (!u.name && name) u.name = name;      // своє імʼя з профілю не затираємо
  u.lastSeen = Date.now();
  db.users[telKey] = u;

  login.status = 'ok';
  login.token = issueToken(telKey);
  login.telKey = telKey;
  save();
  chatLogin.delete(msg.chat.id);

  console.log('Вхід покупця:', telLog(u.tel));
  /* Двома повідомленнями, бо Telegram не дає прибрати клавіатуру й
     одразу дати кнопку: remove_keyboard і inline_keyboard в одному
     reply_markup не живуть.
     Кнопка потрібна, бо вхід забирає екран собі: сайт відкривали з
     Telegram, він переключився на бота — і дороги назад людина не
     знаходила (власник, 22.09). */
  bot.sendMessage(msg.chat.id,
    `Готово, ${u.name || 'вітаємо'}. Номер підтверджено.`,
    { reply_markup: { remove_keyboard: true } })
    .then(() => bot.sendMessage(msg.chat.id, 'Ви вже увійшли — поверніться на сайт і замовляйте.',
      { reply_markup: { inline_keyboard: [[{ text: '↩️ Повернутися на сайт', url: SITE }]] } }))
    .catch(e => console.warn('Вітання після входу:', e.message));
});

bot.onText(/\/points/, msg => {
  bot.sendMessage(msg.chat.id,
    'Точки:\n' + SHOPS.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    '\n\nПрив’язати: /bind 1 КОД');
});

/* Прив'язка змінює, куди підуть гроші клієнтів, тому вона під кодом.
   Без BIND_CODE у змінних оточення прив'язати чат не можна взагалі —
   інакше будь-хто додав би бота до себе в групу і забрав замовлення. */
const BIND_CODE = String(process.env.BIND_CODE || '');

/* У групі команда з меню Telegram приходить як «/bind@імʼя_бота 2 КОД».
   Раніше шаблон чекав пробіл одразу після /bind, і бот мовчав. */
bot.onText(/^\/bind(?:@\w+)?\s*$/, msg => {
  bot.sendMessage(msg.chat.id, 'Допишіть номер точки і код: /bind НОМЕР КОД\nСписок точок — /points');
});

bot.onText(/^\/bind(?:@\w+)?\s+(\d+)(?:\s+(\S+))?/, (msg, m) => {
  const n = parseInt(m[1], 10);
  const code = m[2] || '';

  if (!BIND_CODE) {
    return bot.sendMessage(msg.chat.id,
      'Прив’язку вимкнено. Додайте у змінні проєкту BIND_CODE — і команда запрацює.');
  }
  if (code !== BIND_CODE) {
    console.warn('Спроба прив’язки без коду. Чат:', msg.chat.id, 'від:', msg.from && msg.from.id);
    return bot.sendMessage(msg.chat.id, 'Потрібен код: /bind НОМЕР КОД');
  }
  if (n < 1 || n > SHOPS.length) return bot.sendMessage(msg.chat.id, 'Немає такої точки. /points');

  db.shops[n - 1] = msg.chat.id;
  save();
  console.log('Точку', n, 'прив’язано до чату', msg.chat.id);
  bot.sendMessage(msg.chat.id,
    `Готово. Цей чат отримує замовлення точки:\n${SHOPS[n - 1]}\n\n` +
    `Щоб прив'язка не злетіла після перезапуску сервера, додайте у змінні проєкту:\n` +
    `<code>CHAT_${n} = ${msg.chat.id}</code>\n\n` +
    `Видаліть, будь ласка, повідомлення з кодом із цього чату.`,
    { parse_mode: 'HTML' });
});

bot.onText(/\/whoami/, msg => {
  const i = Object.keys(db.shops).find(k => db.shops[k] === msg.chat.id);
  bot.sendMessage(msg.chat.id, i !== undefined
    ? `Точка: ${SHOPS[i]}\nID чату: ${msg.chat.id}`
    : `Чат ще не прив’язаний. ID: ${msg.chat.id}\nВикористайте /bind НОМЕР КОД`);
});

/* ---------- мангал: зайнятість і надбавки ----------
   Коли мангал забитий живою чергою й телефонами, оператор у чаті точки
   пише /mangal і закриває найближчі години: сайт не дасть обрати на них
   смаження. Зворотний випадок теж буває — сайт вибрав свої 10 кг, а
   мангальщики встигають більше: тоді кнопка «+5 кг» на потрібну годину
   відкриває її знову. Сире мʼясо мангал не займає й не блокується. */
const ADD_STEP_G = 5000;                 // скільки додає одне натискання
const hhmm = ms => new Date(ms).toLocaleTimeString('uk-UA',
  { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
/* Найближчі години, які ще має сенс показувати оператору */
const nextSlots = (n = 3) => {
  const out = [], base = hourFloor(Date.now());
  for (let k = 1; k <= n; k++) out.push(base + k * HOUR);
  return out;
};
const busyKb = i => ({
  inline_keyboard: [
    [{ text: '🔥 Зайнятий на годину', callback_data: `g:${i}:60` },
     { text: '🔥 На дві', callback_data: `g:${i}:120` }],
    [{ text: '🔥 Зайнятий до кінця дня', callback_data: `g:${i}:day` }],
    [{ text: '✅ Вільний, приймаємо', callback_data: `g:${i}:free` }],
    nextSlots().map(ms => ({ text: `+5 кг на ${hhmm(ms)}`, callback_data: `g:${i}:add:${ms}` })),
    [{ text: '♻️ Прибрати надбавки', callback_data: `g:${i}:noadd` }]
  ]
});
function busyText(i) {
  const t = grillBusyUntil(i), load = grillLoad(i), extra = extraOf(i);
  const rows = nextSlots(4).map(ms => {
    const cap = GRILL_CAP_G + (extra[ms] || 0), used = load[ms] || 0;
    return `${hhmm(ms)} — ${wLabel(used)} з ${wLabel(cap)}` +
      (used >= cap ? ' · забито' : '') + (extra[ms] ? ` (+${wLabel(extra[ms])} від вас)` : '');
  }).join('\n');
  return `<b>Мангал · ${esc(SHOPS[i])}</b>\n` +
    (t ? `Для сайту закритий до <b>${hhmm(t)}</b>.\n` : 'Приймає замовлення з сайту.\n') +
    `Сайту віддано ${wLabel(GRILL_CAP_G)} на годину — решту тримаємо на тих, хто прийшов чи подзвонив.\n\n` +
    `<b>Найближчі години</b>\n${rows}\n\n` +
    `Встигаєте більше — додайте кнопкою «+5 кг» на потрібну годину.`;
}
bot.onText(/^\/mangal(?:@\w+)?/, msg => {
  const i = Object.keys(db.shops).find(k => db.shops[k] === msg.chat.id);
  if (i === undefined) return bot.sendMessage(msg.chat.id, 'Цей чат не прив’язаний до точки. /whoami');
  bot.sendMessage(msg.chat.id, busyText(Number(i)), { parse_mode: 'HTML', reply_markup: busyKb(Number(i)) });
});
/* Клієнт тисне «✅ Отримав замовлення» у своєму чаті з ботом */
bot.on('callback_query', async cq => {
  const [tag, noStr] = (cq.data || '').split(':');
  if (tag !== 'r') return;
  const ans = text => bot.answerCallbackQuery(cq.id, { text });
  const o = db.orders[noStr];
  if (!o) return ans('Замовлення не знайдено');
  const u = db.users[o.telKey] || {};
  /* Лише той, на чий номер оформлено замовлення */
  if (!cq.from || !u.tgId || cq.from.id !== u.tgId) return ans('Це замовлення іншої людини');
  const why = receivable(o);
  if (why === 'ok') return ans('Дякуємо, вже відмічено');
  if (why) return ans(why);
  markReceived(o, 'клієнт');
  await bot.editMessageText(`✅ Дякуємо! Замовлення № ${o.no} позначено як отримане.`,
    { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});
  ans('Дякуємо!');
});

/* ---------- один шлях для мангала й стоп-листа ----------
   Те саме правило, що зі статусами й сумами: кнопки в чаті й екрани в
   панелі на планшеті кличуть ці дві функції, а не повторюють їхню
   логіку в себе. Інакше точка бачила б у боті одне, а в панелі інше.
   Повертають {ok:true, note:'що сказати оператору'} або {err:'чому ні'}. */
function applyGrill(shop, act, arg) {
  db.busy = db.busy || {};
  db.extra = db.extra || {};
  if (act === 'add') {
    const slot = hourFloor(Number(arg) || 0);
    if (!slot || slot < hourFloor(Date.now())) {
      return { err: 'Ця година вже минула — відкрийте мангал ще раз' };
    }
    const e = db.extra[shop] || (db.extra[shop] = {});
    e[slot] = (e[slot] || 0) + ADD_STEP_G;
    /* Надбавка означає «беремо ще», тож знімаємо і загальне блокування */
    if (db.busy[shop] && slot < db.busy[shop]) db.busy[shop] = slot;
    save();
    return { ok: true, note: `+${wLabel(ADD_STEP_G)} на ${hhmm(slot)}` };
  }
  if (act === 'noadd') { db.extra[shop] = {}; save(); return { ok: true, note: 'Надбавки прибрано' } }
  if (act === 'free') { db.busy[shop] = 0; save(); return { ok: true, note: 'Мангал знову приймає' } }
  if (act === 'day') {
    /* Після закриття до кінця дня лишається нуль хвилин: блокування
       протухало тієї ж миті, а оператору бот бадьоро відповідав «Закрито
       до кінця дня» — і наступний же екран показував «мангал приймає». */
    const left = tillCloseMs();
    if (!left) return { err: 'Точка вже зачинена — мангал сьогодні нічого не візьме й так' };
    db.busy[shop] = Date.now() + left;
    save();
    return { ok: true, note: 'Закрито до кінця дня' };
  }
  /* решта — «зайнятий на N хвилин»; межа щоб випадкове число не закрило мангал назавжди */
  const min = Number(act) || 0;
  if (!(min > 0 && min <= 600)) return { err: 'Невідома дія' };
  db.busy[shop] = Date.now() + min * 60000;
  save();
  return { ok: true, note: `Закрито до ${hhmm(db.busy[shop])}` };
}

function applyStock(shop, id, off) {
  const it = byId.get(id);
  if (!it) return { err: 'Немає такої позиції' };
  db.stop = db.stop || {};
  const list = db.stop[shop] || (db.stop[shop] = {});
  /* Позиція повертається сама на відкритті — щоб ніхто не забув її ввімкнути */
  if (off) list[id] = nextOpenMs(); else delete list[id];
  save();
  return { ok: true, it,
    note: off ? `${nameOf(it)}: прибрали з сайту до ${OPEN_HOUR}:00` : `${nameOf(it)}: знову в продажу` };
}

bot.on('callback_query', async cq => {
  const [tag, iStr, val, arg] = (cq.data || '').split(':');
  if (tag !== 'g') return;
  const i = Number(iStr), chatId = cq.message && cq.message.chat.id;
  /* Тільки зі свого чату: чужа точка не має чіпати мангал сусідам */
  if (db.shops[i] !== chatId) return bot.answerCallbackQuery(cq.id, { text: 'Це інша точка' });
  const r = applyGrill(i, val, arg);
  if (r.err) return bot.answerCallbackQuery(cq.id, { text: r.err });
  await bot.editMessageText(busyText(i), { chat_id: chatId, message_id: cq.message.message_id,
    parse_mode: 'HTML', reply_markup: busyKb(i) }).catch(() => {});
  bot.answerCallbackQuery(cq.id, { text: r.note });
});

/* ---------- /stop: чого сьогодні немає ---------- */
const shopOfChat = chatId => {
  const i = Object.keys(db.shops).find(k => db.shops[k] === chatId);
  return i === undefined ? null : Number(i);
};
function stopText(shop) {
  const off = stopOf(shop), ids = Object.keys(off);
  const names = ids.map(id => { const it = byId.get(id); return it && nameOf(it) }).filter(Boolean);
  return `<b>Чого сьогодні немає · ${esc(SHOPS[shop])}</b>\n` +
    (names.length ? names.map(n => `🚫 ${esc(n)}`).join('\n') + `\n\nПовертається саме о ${OPEN_HOUR}:00.`
                  : 'Усе в наявності.') +
    `\n\nЩоб прибрати позицію з продажу — напишіть <code>/stop назва</code>\nНаприклад: <code>/stop ошийок</code>`;
}
const stopKb = shop => {
  const rows = Object.keys(stopOf(shop))
    .map(id => byId.get(id)).filter(Boolean)
    .map(it => ([{ text: `✅ Є: ${nameOf(it)}`, callback_data: `sy:${shop}:${it.id}` }]));
  return { inline_keyboard: rows };
};

bot.onText(/^\/stop(?:@\w+)?(?:\s+(.+))?$/, (msg, m) => {
  const shop = shopOfChat(msg.chat.id);
  if (shop === null) return bot.sendMessage(msg.chat.id, 'Цей чат не привʼязаний до точки. /whoami');
  const q = (m[1] || '').trim();
  if (!q) {
    return bot.sendMessage(msg.chat.id, stopText(shop),
      { parse_mode: 'HTML', reply_markup: stopKb(shop) });
  }
  const found = findItems(q);
  if (!found.length) {
    return bot.sendMessage(msg.chat.id, `Не знайшли «${esc(q)}» у прайсі. Спробуйте коротше: <code>/stop ошийок</code>`,
      { parse_mode: 'HTML' });
  }
  const off = stopOf(shop);
  bot.sendMessage(msg.chat.id, `Що саме закінчилось? Позиція зникне з сайту до ${OPEN_HOUR}:00.`, {
    reply_markup: {
      inline_keyboard: found.map(it => ([off[it.id]
        ? { text: `✅ Є: ${it.grp} · ${nameOf(it)}`, callback_data: `sy:${shop}:${it.id}` }
        : { text: `🚫 Немає: ${it.grp} · ${nameOf(it)}`, callback_data: `st:${shop}:${it.id}` }]))
    }
  });
});

bot.on('callback_query', async cq => {
  const [tag, shopStr, id] = (cq.data || '').split(':');
  if (tag !== 'st' && tag !== 'sy') return;
  const shop = Number(shopStr), chatId = cq.message && cq.message.chat.id;
  /* Тільки зі свого чату: чужа точка не має знімати товар сусідам */
  if (db.shops[shop] !== chatId) return bot.answerCallbackQuery(cq.id, { text: 'Це інша точка' });
  const r = applyStock(shop, id, tag === 'st');
  if (r.err) return bot.answerCallbackQuery(cq.id, { text: r.err });

  await bot.editMessageText(stopText(shop),
    { chat_id: chatId, message_id: cq.message.message_id, parse_mode: 'HTML', reply_markup: stopKb(shop) })
    .catch(() => {});
  bot.answerCallbackQuery(cq.id, { text: r.note });
});

/* ---------- нагадування про нове замовлення ----------
   Замовлення, яке ніхто не взяв у роботу, легко губиться в запарці:
   у групі точки згори падають фото, питання й нові замовлення. Через
   5 хвилин бот нагадує і далі щохвилини, поки не натиснуть «Прийняти».
   Щоб не засмічувати чат, попереднє нагадування прибираємо — лишається
   одне, зате завжди свіже й зі звуком. */
const REMIND_AFTER = 5 * 60 * 1000;      // скільки чекаємо перше нагадування
const REMIND_EVERY = 60 * 1000;          // далі — щохвилини
const REMIND_MAX = 60;                   // година нагадувань, далі мовчимо

/* Прибрати нагадування: замовлення взяли в роботу або скасували */
function dropRemind(o) {
  if (!o.remindMsg) return;
  const id = o.remindMsg;
  delete o.remindMsg;
  bot.deleteMessage(o.chatId, id).catch(() => {});
}

async function remindSweep() {
  const now = Date.now();
  for (const no in db.orders) {
    const o = db.orders[no];
    if (o.status !== 'new' || !o.chatId || !o.msgId) continue;
    const age = now - (o.createdAt || 0);
    if (age < REMIND_AFTER) continue;
    if (now - (o.remindAt || 0) < REMIND_EVERY) continue;
    if ((o.remindN || 0) >= REMIND_MAX) continue;

    o.remindAt = now;
    o.remindN = (o.remindN || 0) + 1;
    dropRemind(o);
    save();
    try {
      const m = await bot.sendMessage(o.chatId,
        `⏰ <b>Замовлення № ${o.no}</b> не прийняте вже ${Math.round(age / 60000)} хв.` +
        (o.when ? `\n🕒 ${esc(o.when)}` : '') +
        (o.fry ? `\n🔥 На мангал: ${wLabel(o.fg)}` : ''),
        { parse_mode: 'HTML', reply_to_message_id: o.msgId,
          reply_markup: { inline_keyboard: [[{ text: '✅ Прийняти в роботу', callback_data: `s:${o.no}:accepted` }]] } });
      o.remindMsg = m.message_id;
      save();
    } catch (e) {
      console.warn('Нагадування № ' + o.no + ':', e.message);
    }
  }
}
setInterval(remindSweep, 20 * 1000).unref();

/* ---------- автозакриття доставок ----------
   Клієнт підтверджує отримання сам, але дехто просто не натисне кнопку.
   Через дві години після передачі курʼєру замовлення закриваємо самі
   (власник, 20.09): інакше воно назавжди лишиться «у дорозі» — і в
   смужці на сайті, і в підсумку дня серед «ще в роботі». */
const AUTO_CLOSE_MS = 2 * 3600 * 1000;
function autoCloseSweep() {
  const now = Date.now();
  for (const no in db.orders) {
    const o = db.orders[no];
    if (o.status !== 'onway') continue;
    const since = o.onwayAt || o.updatedAt || 0;
    if (!since || now - since < AUTO_CLOSE_MS) continue;
    markReceived(o, 'автоматично');
    bot.sendMessage(o.chatId,
      `⌛ Замовлення № ${o.no} закрито автоматично: минуло дві години після передачі курʼєру, ` +
      `а клієнт не підтвердив отримання. Якщо щось не так — подзвоніть йому.`,
      { reply_to_message_id: o.msgId }).catch(() => {});
  }
}
setInterval(autoCloseSweep, 5 * 60 * 1000).unref();

/* ---------- забутий самовивіз ----------
   Замовлення готове, мʼясо стигне, місце на мангалі зайняте — а по
   нього ніхто не йде. Нагадуємо кожні 10 хвилин (власник, 22.09), але
   не довше години: далі це вже не нагадування, а набридання.

   Рахуємо не від «Готове», а від пізнішого з двох — готовності й часу
   видачі. Інакше замовлення, зібране на годину раніше за обраний слот,
   починало б смикати людину тоді, коли вона ще й не збиралась їхати. */
const PICKUP_EVERY = 10 * 60 * 1000;
const PICKUP_MAX = 6;                    // година нагадувань
const PICKUP_TELL_SHOP = 3;              // після третього просимо точку подзвонити

/* Клієнт відповідає на нагадування: «вже їду» — мовчимо пів години й
   кажемо про це точці, «не нагадувати» — мовчимо зовсім. Без цього
   людина в заторі отримувала шість повідомлень і нічим не могла їх
   спинити (власник, 22.09). */
const PICKUP_PAUSE = 30 * 60 * 1000;
bot.on('callback_query', async cq => {
  const [tag, noStr, what] = (cq.data || '').split(':');
  if (tag !== 'pk') return;
  const ans = text => bot.answerCallbackQuery(cq.id, { text });
  const o = db.orders[noStr];
  if (!o) return ans('Замовлення не знайдено');
  const u = db.users[o.telKey] || {};
  /* Лише той, на чий номер оформлено замовлення */
  if (!cq.from || !u.tgId || cq.from.id !== u.tgId) return ans('Це замовлення іншої людини');

  if (what === 'off') {
    o.pickN = PICKUP_MAX;                 // більше нагадувань не буде
    o.pickQuiet = true;
  } else {
    o.pickPause = Date.now() + PICKUP_PAUSE;
  }
  save();

  const done = what === 'off'
    ? `🔕 Гаразд, більше не нагадуємо. Замовлення № ${o.no} чекає на вас: ${o.shopName}.`
    : `🚗 Добре, чекаємо. Замовлення № ${o.no}: ${o.shopName}.`;
  await bot.editMessageText(done,
    { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});
  /* Точці кажемо в обох випадках: «їде» — щоб чекали, «не нагадувати» —
     щоб не думали, що про замовлення забули всі. */
  if (o.chatId) {
    bot.sendMessage(o.chatId, what === 'go'
      ? `🚗 Клієнт написав, що вже їде по замовлення № ${o.no}.`
      : `🔕 Клієнт попросив не нагадувати про № ${o.no} — забере, коли зможе.`,
      { reply_to_message_id: o.msgId }).catch(() => {});
  }
  ans(what === 'off' ? 'Не нагадуватимемо' : 'Чекаємо на вас');
});

function pickupSweep() {
  const now = Date.now();
  /* Замовкаємо за пів години до закриття (власник, 22.09): нагадування
     о 19:55 нікому не поможе — людина вже не встигне доїхати. */
  const k = kyivNow();
  const closeMin = (k.getDay() === 0 ? 19 : 20) * 60;
  const nowMin = k.getHours() * 60 + k.getMinutes();
  if (nowMin >= closeMin - 30 || k.getHours() < OPEN_HOUR) return;

  for (const no in db.orders) {
    const o = db.orders[no];
    if (o.mode !== 'pickup' || o.status !== 'ready') continue;
    const from = Math.max(o.readyAt || o.updatedAt || 0, o.slotAt || 0);
    if (!from || now - from < PICKUP_EVERY) continue;
    if (now - (o.pickAt || 0) < PICKUP_EVERY) continue;
    if ((o.pickN || 0) >= PICKUP_MAX) continue;
    if (now < (o.pickPause || 0)) continue;          // сказав «вже їду»

    o.pickAt = now;
    o.pickN = (o.pickN || 0) + 1;
    save();

    const waited = Math.round((now - from) / 60000);
    const u = db.users[o.telKey] || {};
    if (u.tgId) {
      bot.sendMessage(u.tgId,
        o.pickN === 1
          ? `🔔 Замовлення № ${o.no} чекає на вас: ${o.shopName}.`
          : `🔔 Замовлення № ${o.no} готове вже ${waited} хв і чекає: ${o.shopName}.` +
            (o.pickN >= PICKUP_MAX ? '\nЯкщо плани змінились — зателефонуйте, будь ласка, на точку.' : ''),
        { reply_markup: { inline_keyboard: [
          [{ text: '🚗 Вже їду', callback_data: `pk:${o.no}:go` },
           { text: '🔕 Не нагадувати', callback_data: `pk:${o.no}:off` }],
          [{ text: 'Відкрити замовлення', url: SITE + '?order=' + o.no }]
        ] } })
        .catch(e => console.warn('Нагадування про самовивіз № ' + o.no + ':', e.message));
    }
    /* Хто не входив через Telegram, нагадування не отримає: SMS за кожні
       10 хвилин — це гроші й роздратування. Тоді просто раніше кажемо
       точці, щоб зателефонувала. */
    const tellShop = u.tgId ? o.pickN === PICKUP_TELL_SHOP : o.pickN === 1;
    if (tellShop && o.chatId) {
      bot.sendMessage(o.chatId,
        `⏳ Замовлення № ${o.no} готове вже ${waited} хв, але його не забрали.\n` +
        `Може, варто зателефонувати: ${o.tel}`,
        { reply_to_message_id: o.msgId })
        .catch(e => console.warn('Нагадування точці № ' + o.no + ':', e.message));
    }
  }
}
setInterval(pickupSweep, 60 * 1000).unref();

/* ---------- підсумок дня ----------
   Скільки замовлень, кілограмів і грошей зробила точка за день. Приходить
   сам після закриття, а до того його можна спитати командою /day. */
const kyivDate = (ts = Date.now()) =>
  new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });   // 2026-09-19
/* Замовлення на інший день: слот припадає на пізнішу київську дату.
   Такі не готують сьогодні — мангальщики фізично не можуть. */
const futureDay = o => !!o.slotAt && kyivDate(o.slotAt) > kyivDate();
/* «21.09» або «завтра» — коротко, для кнопок і картки */
function dayShort(ms) {
  const d = kyivDate(ms), t = kyivDate(), tm = kyivDate(Date.now() + 24 * 3600 * 1000);
  if (d === t) return 'сьогодні';
  if (d === tm) return 'завтра';
  const [, m, dd] = d.split('-');
  return `${dd}.${m}`;
}

function dayStats(shop, day) {
  const list = Object.values(db.orders)
    .filter(o => o.shop === shop && kyivDate(o.createdAt) === day);
  const live = list.filter(o => o.status !== CANCELED);
  const sum = live.reduce((s, o) => s + (o.total || 0), 0);
  const fg = live.reduce((s, o) => s + (o.fry ? (o.fg || 0) : 0), 0);
  return {
    all: list.length,
    canceled: list.filter(o => o.status === CANCELED).length,
    open: list.filter(o => !FINAL.has(o.status)).length,
    pickup: live.filter(o => o.mode === 'pickup').length,
    delivery: live.filter(o => o.mode === 'delivery').length,
    ship: live.reduce((s, o) => s + (o.ship || 0), 0),
    sum, fg
  };
}

function dayText(shop, day) {
  const d = dayStats(shop, day);
  const [y, m, dd] = day.split('-');
  if (!d.all) return `📊 <b>${esc(SHOPS[shop])}</b> · ${dd}.${m}\nЗамовлень із сайту сьогодні не було.`;
  return `📊 <b>Підсумок дня · ${esc(SHOPS[shop])}</b> · ${dd}.${m}\n` +
    `Замовлень: <b>${d.all - d.canceled}</b> (самовивіз ${d.pickup}, доставка ${d.delivery})\n` +
    `На мангал: <b>${wLabel(d.fg)}</b>\n` +
    `Сума: <b>${money(d.sum)}</b>` + (d.ship ? ` (з них доставка ${money(d.ship)})` : '') +
    (d.canceled ? `\nСкасовано: ${d.canceled}` : '') +
    (d.open ? `\nЩе в роботі: ${d.open}` : '');
}

bot.onText(/^\/day(?:@\w+)?/, msg => {
  const i = Object.keys(db.shops).find(k => db.shops[k] === msg.chat.id);
  if (i === undefined) return bot.sendMessage(msg.chat.id, 'Цей чат не прив’язаний до точки. /whoami');
  bot.sendMessage(msg.chat.id, dayText(Number(i), kyivDate()), { parse_mode: 'HTML' });
});

/* ---------- панель точки ----------
   У чаті добре видно одне замовлення, але коли їх сорок, вони тонуть
   між нагадуваннями й розмовами: заказ на 18:00 їде вгору, і оператор
   гортає стрічку (власник, 23.09; на вихідних точки ловлять по 300
   пропущених дзвінків, і сайт має ту лінію розвантажити).

   Панель — окрема сторінка для планшета точки: усі активні замовлення
   на одному екрані, за часом видачі. Вхід простий: у чаті точки
   `/panel`, бот дає посилання з разовим кодом; планшет міняє код на
   ключ і далі просто відкриває вкладку. Ключ привʼязаний до точки, тож
   із планшета Шевченка видно лише Шевченка. */
const PANEL_CODE_TTL = 10 * 60 * 1000;
const panelCodes = new Map();          // разовий код → { shop, at }
setInterval(() => {
  const now = Date.now();
  for (const [c, v] of panelCodes) if (now - v.at > PANEL_CODE_TTL) panelCodes.delete(c);
}, 60 * 1000).unref();

bot.onText(/^\/panel(?:@\w+)?/, msg => {
  const shop = shopOfChat(msg.chat.id);
  if (shop === null) return bot.sendMessage(msg.chat.id, 'Цей чат не привʼязаний до точки. /whoami');
  const code = crypto.randomBytes(5).toString('hex');
  panelCodes.set(code, { shop, at: Date.now() });
  bot.sendMessage(msg.chat.id,
    `<b>Панель точки</b> · ${esc(SHOPS[shop])}\n\n` +
    `Відкрийте це посилання на планшеті — і більше вводити нічого не треба:\n` +
    `${SITE}op.html#${code}\n\n` +
    `Посилання діє 10 хвилин і лише один раз. Загубився планшет — напишіть /panel ще раз, ` +
    `старий доступ тоді краще відкликати командою /panel-off.`,
    { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.onText(/^\/panel-off(?:@\w+)?/, msg => {
  const shop = shopOfChat(msg.chat.id);
  if (shop === null) return;
  db.panel = db.panel || {};
  let n = 0;
  for (const t in db.panel) if (db.panel[t].shop === shop) { delete db.panel[t]; n++ }
  save();
  bot.sendMessage(msg.chat.id, n
    ? `Відкликано доступів: ${n}. Щоб зайти знову — /panel.`
    : 'Активних доступів до панелі немає.');
});

/* Код у ключ. Код одноразовий: підгледіли посилання через годину —
   воно вже нічого не відкриє. */
app.post('/api/op/claim', (req, res) => {
  if (tooOften('auth', ipOf(req), RATE.auth)) {
    return res.status(429).json({ error: 'Забагато спроб. Зачекайте кілька хвилин.' });
  }
  const code = String((req.body || {}).code || '');
  const rec = panelCodes.get(code);
  if (!rec || Date.now() - rec.at > PANEL_CODE_TTL) {
    return res.status(403).json({ error: 'Посилання застаріло. Напишіть /panel у чаті точки ще раз.' });
  }
  panelCodes.delete(code);
  const token = crypto.randomBytes(24).toString('hex');
  db.panel = db.panel || {};
  db.panel[token] = { shop: rec.shop, at: Date.now() };
  save();
  res.json({ ok: true, token, shop: rec.shop, shopName: SHOPS[rec.shop] });
});

/* Хто прийшов із планшета точки */
function panelOf(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const rec = token && (db.panel || {})[token];
  if (!rec) return null;
  rec.seen = Date.now();
  return { token, shop: rec.shop };
}

/* Усе, що оператору треба бачити: склад, суму, телефон, адресу. Це вже
   не «публічний» вигляд замовлення — панель за ключем точки. */
const opOrder = o => ({
  no: o.no, status: o.status, label: LABEL[o.status],
  mode: o.mode, slotAt: o.slotAt || 0, when: o.when || '',
  /* Порожньо для сьогоднішніх, «завтра» чи «26.09» — для решти. Без цього
     в картці стояв самий час, і замовлення на завтра на 17:00 виглядало
     так само, як сьогоднішнє на 17:00. Дату рахує сервер: планшет може
     стояти з будь-яким часовим поясом. */
  day: futureDay(o) ? dayShort(o.slotAt) : '',
  createdAt: o.createdAt, readyAt: o.readyAt || 0, onwayAt: o.onwayAt || 0,
  total: o.total, totalOrig: o.totalOrig, adjust: adjustmentsOf(o),
  fry: !!o.fry, fg: o.fg || 0, pay: o.pay,
  nm: o.nm, tel: o.tel, addr: o.addr || '', note: o.note || '',
  mismatch: o.mismatch || null,
  /* Коли можна братися — панель підсвітить, а не дасть натиснути дарма */
  startAt: o.slotAt ? o.slotAt - (o.mode === 'delivery' ? 90 : 60) * 60000 : 0,
  /* Що саме зараз дозволено міняти: панель питає тут, а не вгадує —
     правила живуть на сервері й міняються разом із ним. */
  can: { money: canEdit(o, 'fact'), ship: canEdit(o, 'ship'), cancel: canEdit(o, 'cancel') },
  lines: (o.lines || []).map(l => ({ name: nameOf(l), qty: l.g, unit: l.unit, sum: l.sum, fry: !!l.fry, v: l.v || '' }))
});

app.get('/api/op/orders', (req, res) => {
  if (tooOften('status', ipOf(req), RATE.status)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const a = panelOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібен доступ. У чаті точки — /panel' });
  const DAY = 24 * 3600 * 1000;
  const list = Object.values(db.orders)
    .filter(o => o.shop === a.shop && (!FINAL.has(o.status) || Date.now() - (o.updatedAt || o.createdAt || 0) < 2 * 3600 * 1000))
    .filter(o => Date.now() - (o.createdAt || 0) < 3 * DAY)
    /* Найближче за часом видачі — зверху: саме цим замовленням треба
       займатись першими. Без часу (якнайшвидше) — за номером. */
    .sort((x, y) => (x.slotAt || x.createdAt || 0) - (y.slotAt || y.createdAt || 0))
    .map(opOrder);
  res.json({ ok: true, shop: a.shop, shopName: SHOPS[a.shop], now: Date.now(), orders: list });
});

/* Уточнити суму, дописати коментар або скасувати — те саме, що кнопками
   в боті, але формою просто в картці. Ім'я оператора з панелі не
   візьмеш, тож підписуємо точкою: у чаті видно, що зміна прийшла звідти. */
app.post('/api/op/order/:no/adjust', async (req, res) => {
  const a = panelOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібен доступ. У чаті точки — /panel' });
  const o = db.orders[req.params.no];
  if (!o) return res.status(404).json({ error: 'Замовлення не знайдено' });
  if (o.shop !== a.shop) return res.status(403).json({ error: 'Це замовлення іншої точки' });

  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!['fact', 'add', 'sub', 'note', 'ship', 'cancel'].includes(kind)) {
    return res.status(400).json({ error: 'Невідома зміна' });
  }
  const amount = kop(Number(b.amount) || 0);
  const note = String(b.note || '').trim().slice(0, 200);
  const r = await applyAdjust(o, kind, amount, note, 'панель · ' + SHOPS[a.shop]);
  if (r.err) return res.status(409).json({ error: r.err, order: opOrder(o) });
  res.json({ ok: true, order: opOrder(o) });
});

/* ---------- стоп-лист і мангал у панелі ----------
   У боті це /stop і /mangal. На планшеті оператору зручніше екраном:
   пошук по прайсу під палець і завантаження годин одразу видно.
   Стан обох екранів віддаємо однією відповіддю — панель і так опитує
   сервер по колу, зайвий запит їй ні до чого. */
const opShopState = shop => {
  /* Показуємо лише години, коли точка ще працює: після закриття мангал
     нічого не візьме, а зайві рядки на планшеті тільки заважають.
     Поточну годину теж показуємо — саме її оператор зараз і смажить.
     Нових замовлень із сайту на неї не буде (там мінімум година наперед),
     тож панель малює її довідково, без кнопки надбавки. Без цього о 19:02
     екран мангала виявлявся порожнім: попереду до 20:00 цілих годин нема. */
  const closeAt = Date.now() + tillCloseMs();
  const nowSlot = hourFloor(Date.now());
  const slots = [nowSlot, ...nextSlots(5)].filter(ms => ms < closeAt);
  return {
    /* Час і година відкриття їдуть у кожній відповіді: планшет може стояти
       з будь-яким годинником, а «закрито до 19:40» рахується від нашого. */
    now: Date.now(), openHour: OPEN_HOUR,
    stop: Object.keys(stopOf(shop)),
    grill: {
      cap: GRILL_CAP_G, step: ADD_STEP_G,
      busyUntil: grillBusyUntil(shop),
      extra: extraOf(shop),
      load: grillLoad(shop),
      slots, nowSlot,
      /* Панель малює час київський, а планшет може стояти з будь-яким —
         тож години підписує сервер, а не браузер. */
      labels: slots.map(hhmm)
    }
  };
};

app.get('/api/op/shop', (req, res) => {
  const a = panelOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібен доступ. У чаті точки — /panel' });
  res.json({ ok: true, ...opShopState(a.shop) });
});

app.post('/api/op/stock', (req, res) => {
  const a = panelOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібен доступ. У чаті точки — /panel' });
  const b = req.body || {};
  const r = applyStock(a.shop, String(b.id || ''), !!b.off);
  if (r.err) return res.status(400).json({ error: r.err });
  res.json({ ok: true, note: r.note, ...opShopState(a.shop) });
});

app.post('/api/op/grill', (req, res) => {
  const a = panelOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібен доступ. У чаті точки — /panel' });
  const b = req.body || {};
  const r = applyGrill(a.shop, String(b.act || ''), b.slot);
  if (r.err) return res.status(400).json({ error: r.err });
  res.json({ ok: true, note: r.note, ...opShopState(a.shop) });
});

app.post('/api/op/order/:no/status', async (req, res) => {
  const a = panelOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібен доступ. У чаті точки — /panel' });
  const o = db.orders[req.params.no];
  if (!o) return res.status(404).json({ error: 'Замовлення не знайдено' });
  if (o.shop !== a.shop) return res.status(403).json({ error: 'Це замовлення іншої точки' });
  const r = await applyStatus(o, String((req.body || {}).status || ''));
  if (r.err) return res.status(409).json({ error: r.err, order: opOrder(o) });
  res.json({ ok: true, order: opOrder(o) });
});

/* ---------- підсумки за тиждень і місяць ----------
   `/day` бачить лише сьогодні й лише свою точку. Власнику потрібне
   інше: як ідуть справи взагалі й куди рухається кожна точка — щоб
   рішення (ціни, години, закупівля) стояли на цифрах (власник, 22.09).

   У чаті точки команда показує свою точку, в особистих із власником —
   обидві й разом. Хто власник, бот знає зі змінної OWNER_ID: цифри
   виторгу не для випадкового чату. */
const OWNER_ID = Number(process.env.OWNER_ID || 0);
const isOwner = msg => !!OWNER_ID && msg.from && msg.from.id === OWNER_ID;
const kyivHour = ms => Number(new Date(ms)
  .toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }));

function statsRange(shopList, from, to) {
  const list = Object.values(db.orders).filter(o =>
    shopList.includes(o.shop) && (o.createdAt || 0) >= from && (o.createdAt || 0) < to);
  const live = list.filter(o => o.status !== CANCELED);
  const sum = live.reduce((s, o) => s + (o.total || 0), 0);
  const items = {}, hours = {};
  for (const o of live) {
    const seen = new Set();
    for (const l of (o.lines || [])) {
      if (!l.id || seen.has(l.id) || !byId.has(l.id)) continue;
      seen.add(l.id);
      items[l.id] = (items[l.id] || 0) + 1;
    }
    /* Рахуємо за часом видачі, а не оформлення: точці важливо, коли до
       неї приходять, а не коли натиснули кнопку на сайті. */
    const t = o.slotAt || o.createdAt;
    if (t) { const h = kyivHour(t); hours[h] = (hours[h] || 0) + 1; }
  }
  return {
    n: live.length,
    canceled: list.length - live.length,
    sum, avg: live.length ? sum / live.length : 0,
    fg: live.reduce((s, o) => s + (o.fry ? (o.fg || 0) : 0), 0),
    pickup: live.filter(o => o.mode === 'pickup').length,
    delivery: live.filter(o => o.mode === 'delivery').length,
    ship: live.reduce((s, o) => s + (o.ship || 0), 0),
    items, hours
  };
}
/* «▲ +12% до попередніх» — без порівняння цифра нічого не каже */
const cmp = (a, b) => {
  if (!b) return '';
  const d = Math.round((a - b) / b * 100);
  return d ? ` <i>(${d > 0 ? '▲ +' : '▼ '}${d}%)</i>` : ' <i>(без змін)</i>';
};
function statsText(shopList, days, title) {
  const now = Date.now(), span = days * 24 * 3600 * 1000;
  const cur = statsRange(shopList, now - span, now);
  const prev = statsRange(shopList, now - 2 * span, now - span);
  const head = title || (shopList.length === 1 ? SHOPS[shopList[0]] : 'Разом по мережі');
  if (!cur.n) return `📈 <b>${esc(head)}</b> · ${days} днів\nЗамовлень із сайту не було.`;
  const top = Object.entries(cur.items).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, n], k) => { const it = byId.get(id); return `${k + 1}. ${esc(it ? nameOf(it) : id)} — ${n}` }).join('\n');
  const hours = Object.entries(cur.hours).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([h, n]) => `${String(h).padStart(2, '0')}:00 — ${n}`).join(' · ');
  return `📈 <b>${esc(head)}</b> · останні ${days} днів\n` +
    `Замовлень: <b>${cur.n}</b>${cmp(cur.n, prev.n)}\n` +
    `Сума: <b>${money(cur.sum)}</b>${cmp(cur.sum, prev.sum)}\n` +
    `Середній чек: <b>${money(Math.round(cur.avg))}</b>${cmp(cur.avg, prev.avg)}\n` +   // копійки тут ні до чого
    `Самовивіз ${cur.pickup} · доставка ${cur.delivery}` +
    (cur.ship ? ` (доставка ${money(cur.ship)})` : '') + `\n` +
    `На мангал: <b>${wLabel(Math.round(cur.fg))}</b>${cmp(cur.fg, prev.fg)}\n` +
    (cur.canceled ? `Скасовано: ${cur.canceled}\n` : '') +
    `\n<b>Що беруть найчастіше</b>\n${top}\n` +
    (hours ? `\n<b>Коли забирають</b>\n${hours}` : '');
}

/* ---------- щоденна копія бази ----------
   Телефони, адреси й історія покупців живуть на одному диску Railway.
   Скінчиться кредит, злетить сервіс — і все це зникне без сліду
   (власник питав про захист 23.09). Тепер раз на добу після закриття
   бот надсилає власнику файл бази в особисті: це і резервна копія, і
   спосіб забрати дані з собою, якщо колись переїжджатимемо з Railway.
   Файл маленький — кілька сотень кілобайтів навіть із сотнями
   замовлень. Руками копію можна попросити командою /backup. */
const BACKUP_HOUR = 21;                 // після закриття точки
async function sendBackup(to, why) {
  writeNow();                           // спершу скидаємо на диск усе, що в памʼяті
  const day = kyivDate();
  const size = (() => { try { return fs.statSync(DB).size } catch (e) { return 0 } })();
  return bot.sendDocument(to, DB, {
    caption: `🗄 Копія бази · ${day}${why ? ' · ' + why : ''}\n` +
      `Замовлень: ${Object.keys(db.orders).length}, покупців: ${Object.keys(db.users).length}, ` +
      `розмір: ${Math.max(1, Math.round(size / 1024))} КБ`
  }, { filename: `meat-baron-${day}.json`, contentType: 'application/json' });
}

function backupSweep() {
  if (!OWNER_ID) return;
  const k = kyivNow();
  if (k.getHours() < BACKUP_HOUR) return;
  const day = kyivDate();
  if (db.backupSent === day) return;
  db.backupSent = day;
  save();
  sendBackup(OWNER_ID).catch(e => {
    console.warn('Копія бази не надіслалась:', e.message);
    db.backupSent = '';                 // спробуємо ще раз наступного такту
    save();
  });
}
setInterval(backupSweep, 10 * 60 * 1000).unref();

bot.onText(/^\/backup(?:@\w+)?/, msg => {
  if (!msg.chat || msg.chat.type !== 'private' || !isOwner(msg)) return;
  sendBackup(msg.chat.id, 'на запит').catch(e =>
    bot.sendMessage(msg.chat.id, 'Не вдалося надіслати копію: ' + e.message));
});

/* Що зараз коїться на сервері — власнику в особисті. Раніше це показував
   відкритий /api/health, але кількість замовлень і покупців стороннім
   знати ні до чого. */
bot.onText(/^\/status(?:@\w+)?/, msg => {
  if (!msg.chat || msg.chat.type !== 'private' || !isOwner(msg)) return;
  const up = Math.round((Date.now() - STARTED) / 60000);
  bot.sendMessage(msg.chat.id,
    `⚙️ <b>Сервер</b>\n` +
    `Код: <code>${BUILD || 'невідомо'}</code>, працює ${up < 60 ? up + ' хв' : Math.round(up / 60) + ' год'}\n` +
    `Замовлень у базі: <b>${Object.keys(db.orders).length}</b>, покупців: <b>${Object.keys(db.users).length}</b>\n` +
    `Сховище: ${process.env.DATA_DIR ? 'постійний диск' : '⚠️ тимчасове'}\n\n` +
    SHOPS.map((s, i) => `${db.shops[i] ? '✅' : '⚠️'} ${esc(s)}`).join('\n') +
    `\n\nКопія бази: /backup`,
    { parse_mode: 'HTML' });
});

/* ---------- обнулення бази перед запуском ----------
   Поки сайт не в роботі, у базі лежать замовлення, які власник із
   працівниками наклацали на тестах. Вони псують «Популярне» (клієнти
   побачили б натиснуте, а не куплене) і перший же підсумок тижня, бо
   порівнюватиметься з тестовим. Тому перед запуском усе стираємо.

   Команда лише в особистих із власником і лише з підтвердженням.
   Прив'язки точок не чіпаємо: без них замовлення перестануть
   доходити в чати. Стару базу перед стиранням відкладаємо копією —
   диск на Railway постійний, місця це майже не займе. */
const resetAsks = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of resetAsks) if (now - a.at > 5 * 60 * 1000) resetAsks.delete(k);
}, 60 * 1000).unref();

bot.onText(/^\/reset(?:@\w+)?/, msg => {
  if (!msg.chat || msg.chat.type !== 'private') {
    return bot.sendMessage(msg.chat.id, 'Обнулення бази — лише в особистих із власником.');
  }
  if (!isOwner(msg)) {
    return bot.sendMessage(msg.chat.id, OWNER_ID
      ? 'Ця команда лише для власника.'
      : 'Спершу додайте у змінні проєкту OWNER_ID — ваш номер покаже /whoami.');
  }
  const id = crypto.randomBytes(4).toString('hex');
  resetAsks.set(id, { at: Date.now() });
  bot.sendMessage(msg.chat.id,
    `⚠️ <b>Стерти всі дані?</b>\n\n` +
    `Замовлень: <b>${Object.keys(db.orders).length}</b>\n` +
    `Покупців: <b>${Object.keys(db.users).length}</b>\n\n` +
    `Наступне замовлення отримає № 1001. Усі, хто входив на сайті, ` +
    `вийдуть і зайдуть заново. Прив'язки точок лишаються.\n` +
    `Стара база збережеться копією на диску.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
      { text: '🗑 Так, стерти', callback_data: `rs:${id}` },
      { text: 'Скасувати', callback_data: `rx:${id}` }
    ]] } });
});

bot.on('callback_query', async cq => {
  const [tag, id] = (cq.data || '').split(':');
  if (tag !== 'rs' && tag !== 'rx') return;
  const ask = resetAsks.get(id);
  if (!ask) return bot.answerCallbackQuery(cq.id, { text: 'Підтвердження застаріло — наберіть /reset ще раз' });
  resetAsks.delete(id);
  if (!OWNER_ID || !cq.from || cq.from.id !== OWNER_ID) {
    return bot.answerCallbackQuery(cq.id, { text: 'Лише для власника' });
  }
  const chatId = cq.message.chat.id, msgId = cq.message.message_id;
  if (tag === 'rx') {
    await bot.editMessageText('Обнулення скасовано — усе лишилось як було.',
      { chat_id: chatId, message_id: msgId }).catch(() => {});
    return bot.answerCallbackQuery(cq.id, { text: 'Скасовано' });
  }

  const had = { orders: Object.keys(db.orders).length, users: Object.keys(db.users).length };
  let keep = '';
  try {
    writeNow();                                   // спершу зберігаємо те, що є
    keep = DB.replace(/\.json$/, '') + '.before-reset-' + Date.now() + '.json';
    fs.copyFileSync(DB, keep);
  } catch (e) {
    console.error('Копія перед обнуленням не вдалась:', e.message);
    await bot.editMessageText('Не вдалося зробити копію бази — нічого не стирав. ' + e.message,
      { chat_id: chatId, message_id: msgId }).catch(() => {});
    return bot.answerCallbackQuery(cq.id, { text: 'Скасовано' });
  }

  db.orders = {}; db.users = {}; db.tokens = {};
  db.busy = {}; db.extra = {}; db.daySent = {}; db.stop = {};
  db.counter = 1000;                              // наступне замовлення — № 1001
  writeNow();
  console.log('База обнулена власником. Копія:', keep);

  await bot.editMessageText(
    `🗑 <b>Готово.</b>\n\nСтерто замовлень: ${had.orders}, покупців: ${had.users}.\n` +
    `Наступне замовлення — № 1001.\nКопія: <code>${esc(keep)}</code>`,
    { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(() => {});
  bot.answerCallbackQuery(cq.id, { text: 'База обнулена' });
});

bot.onText(/^\/(week|month)(?:@\w+)?/, (msg, m) => {
  const days = m[1] === 'week' ? 7 : 30;
  const shop = shopOfChat(msg.chat.id);
  if (shop !== null) {
    return bot.sendMessage(msg.chat.id, statsText([shop], days), { parse_mode: 'HTML' });
  }
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(msg.chat.id, 'Цей чат не привʼязаний до точки. /whoami');
  }
  if (!isOwner(msg)) {
    return bot.sendMessage(msg.chat.id, OWNER_ID
      ? 'Ці цифри доступні точкам і власнику.'
      : 'Щоб бачити підсумки тут, додайте у змінні проєкту OWNER_ID зі своїм номером — його покаже /whoami.');
  }
  const parts = SHOPS.map((_, i) => statsText([i], days));
  if (SHOPS.length > 1) parts.push(statsText(SHOPS.map((_, i) => i), days, 'Разом по мережі'));
  bot.sendMessage(msg.chat.id, parts.join('\n\n'), { parse_mode: 'HTML' });
});

/* Після закриття надсилаємо самі — один раз на день на точку */
function daySweep() {
  const k = kyivNow();
  const close = k.getDay() === 0 ? 19 : 20;
  if (k.getHours() < close) return;
  const day = kyivDate();
  db.daySent = db.daySent || {};
  for (const i of Object.keys(db.shops)) {
    if (db.daySent[i] === day) continue;
    db.daySent[i] = day;
    save();
    bot.sendMessage(db.shops[i], dayText(Number(i), day), { parse_mode: 'HTML' })
      .catch(e => console.warn('Підсумок дня точці ' + i + ':', e.message));
  }
}
setInterval(daySweep, 5 * 60 * 1000).unref();

/* ---------- текст замовлення ---------- */
function orderText(o) {
  const lines = o.lines.map(l => {
    /* Фритюр — порціями з вагою: кухні треба знати, скільки грамів
       відпускати, а «2 шт» цього не каже. */
    const u = countUnitOf(l);
    const qty = l.unit === 'шт' ? (u ? `${l.g} ${u.s}${u.g ? ` (${l.g * u.g} г)` : ''}` : l.g + ' шт')
              : l.unit === 'пак' ? l.g + ' × ' + packLabel(l)
              : portionOf(l) ? `${Math.round(l.g / portionOf(l))} шт (≈${wLabel(l.g)})`   // картопля з салом: штуками, але на вагу
              : wLabel(l.g);
    /* Вогник біля позиції — щоб оператор бачив, що саме на мангал.
       Смаження тепер обирають на кожній позиції окремо, і одного
       підсумку внизу вже не досить. */
    return `• ${esc(lineTitle(l))} — ${qty} — ${money(l.sum)}${l.fry ? ' 🔥' : ''}`;
  }).join('\n');

  const fry = o.fry
    ? `\n🔥 НА МАНГАЛ (позначені вогником): ${wLabel(o.fg)} — ${money(o.fg / 1000 * FRY_RATE)}\n   (ужарка 30–35%)`
    : '';

  const delivery = o.mode === 'delivery'
    ? `\n🚚 ДОСТАВКА: ${esc(o.addr) || '—'}\n   ⚠️ передзвонити, уточнити вартість доставки`
    : `\n🏪 САМОВИВІЗ: ${esc(o.shopName)}`;

  const pay = { cash: '💵 Готівкою', card: '💳 Карткою на місці' }[o.pay] || o.pay;
  const when = o.when ? `\n🕒 <b>${esc(o.when)}</b>` : '';
  /* Замовлення на інший день видно одразу: щоб ніхто не кинувся смажити
     сьогодні те, що заберуть завтра. */
  const later = futureDay(o) ? `\n⏳ <b>На ${dayShort(o.slotAt)}</b> — у роботу того дня` : '';

  /* Сайт показав клієнту іншу суму: або в нього застарілий кеш після
     зміни цін, або запит підроблено. Правильна — та, що нижче. */
  const warn = o.mismatch
    ? `\n⚠️ <b>На сайті клієнт бачив ${money(o.mismatch)}</b> — перевірте ціни\n`
    : '';

  /* Зміни оператора — кожна окремим рядком, щоб на точці було видно, з
     чого склалась сума і хто що вніс. */
  const adj = adjustmentsOf(o);
  const who = a => (a.by ? ` <i>(${esc(a.by)})</i>` : '');
  const adjLines = adj.map(a =>
    a.kind === 'note' ? `💬 ${esc(a.note)}` + who(a)
    : a.kind === 'fact' ? `🧾 Фактична сума з каси: ${money(a.amount)} (було ${money(a.from)})` + (a.note ? ` — ${esc(a.note)}` : '') + who(a)
    : a.kind === 'ship' ? `🚕 Доставка: ${money(a.amount)}` + (a.from ? ` (було ${money(a.from)})` : '') + (a.note ? ` — ${esc(a.note)}` : '') + who(a)
    : a.kind === 'cancel' ? `✖️ Скасовано: ${esc(a.note)}` + who(a)
    : `${a.kind === 'add' ? '➕' : '➖'} ${money(a.amount)}` + (a.note ? ` — ${esc(a.note)}` : '') + who(a)
  ).join('\n');
  const changed = adj.some(a => a.kind !== 'note' && a.kind !== 'cancel');
  const sum = adj.length
    ? (changed ? `На сайті: ${money(o.totalOrig)}\n` : '') + `${adjLines}\n` +
      `<b>${changed ? 'До сплати' : 'Разом'}: ${money(o.total)}</b>${warn}\n` +
      (EDITABLE.has(o.status) ? '' : `<i>Суму зафіксовано</i>\n`) + `\n`
    : `<b>Разом: ${money(o.total)}</b>${warn}\n` +
      `<i>Сума орієнтовна — до «Готується» можна додати ➕ чи відняти ➖</i>\n\n`;

  /* Хто підтвердив отримання: клієнт кнопкою чи оператор руками */
  const got = o.status !== 'done' ? ''
    : o.gotBy === 'клієнт' ? ' · клієнт підтвердив'
    : o.gotBy === 'автоматично' ? ' · закрито автоматично' : '';
  return `<b>Замовлення № ${o.no}</b> — ${LABEL[o.status]}${got}\n` +
    `${delivery}${when}${later}\n${pay}\n\n${lines}${fry}\n\n` +
    sum +
    `👤 ${esc(o.nm)}\n📞 ${esc(o.tel)}` +
    (o.note ? `\n\n💬 <b>Коментар:</b> ${esc(o.note)}` : '');
}

/* Чи можна зараз вносити саме цю зміну: доставку — майже до видачі,
   решту — лише поки замовлення не готується. */
const canEdit = (o, kind) =>
    kind === 'ship'   ? (o.mode === 'delivery' && SHIP_OK.has(o.status))
  : kind === 'cancel' ? cancelable(o)
  : EDITABLE.has(o.status) && o.status !== CANCELED;
const lockedText = kind => kind === 'cancel'
  ? 'Замовлення вже видано або скасовано'
  : kind === 'ship'
  ? 'Замовлення вже видано — вартість доставки змінити не можна'
  : LOCKED_TEXT;

/* Суму й коментарі оператор міняє лише до «Готується». Далі замовлення
   вже в роботі, і сума має лишатися тією, яку бачив клієнт. */
const EDITABLE = new Set(['new', 'accepted']);
/* Скасувати можна, поки замовлення не видане
   (і поки воно вже не скасоване) */
const cancelable = o => !FINAL.has(o.status);
/* Вартість доставки — виняток: таксі викликають, коли замовлення вже
   готується чи готове, тож вписати її можна майже до видачі. */
const SHIP_OK = new Set(['new', 'accepted', 'cooking', 'ready']);

/* Зміни суми списком: [{ kind: 'add' | 'sub' | 'note', amount, note, by, at }].
   Перша версія (одна абсолютна сума з коментарем) лежала в totalOrig і
   totalNote — такі замовлення показуємо як одну зміну. */
function adjustmentsOf(o) {
  if (Array.isArray(o.adjust)) return o.adjust;
  if (o.totalOrig == null) return [];
  const d = kop(o.total - o.totalOrig);
  if (!d && !o.totalNote) return [];
  return [{ kind: d < 0 ? 'sub' : 'add', amount: Math.abs(d), note: o.totalNote || '', by: o.totalBy || '', at: o.totalAt || 0 }];
}
/* Для клієнта: без імен операторів */
const pubAdjust = o => adjustmentsOf(o).map(a => ({ kind: a.kind, amount: a.amount || 0, note: a.note || '',
  ...(a.kind === 'fact' || a.kind === 'ship' ? { from: a.from } : {}) }));

function keyboard(o) {
  /* Доставку вписують окремою кнопкою: суму каже таксі, а не каса */
  if (o.status === CANCELED) return { inline_keyboard: [] };   // скасоване не чіпаємо
  const btns = nextBtns(o).map(([st, txt]) => ([{ text: txt, callback_data: `s:${o.no}:${st}` }]));
  if (o.mode === 'delivery' && SHIP_OK.has(o.status)) btns.push(
    [{ text: o.ship ? '🚕 Змінити вартість доставки' : '🚕 Вартість доставки', callback_data: `a:${o.no}:ship` }]);
  /* Скасування — окремим рядком унизу, щоб не тиснули випадково */
  if (cancelable(o)) btns.push([{ text: '✖️ Скасувати замовлення', callback_data: `a:${o.no}:cancel` }]);
  if (EDITABLE.has(o.status)) btns.push(
    [{ text: '🧾 Фактична сума', callback_data: `a:${o.no}:fact` }],
    [
      { text: '➕ Додати', callback_data: `a:${o.no}:add` },
      { text: '➖ Відняти', callback_data: `a:${o.no}:sub` },
      { text: '💬 Коментар', callback_data: `a:${o.no}:note` }
    ]);
  return { inline_keyboard: btns };
}

/* ---------- захист від напливу запитів ---------- */
const RATE_WINDOW = 10 * 60 * 1000;           // вікно 10 хвилин
const buckets = new Map();                    // "кошик:ip" → [часи запитів]

const fresh = key => {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter(t => now - t < RATE_WINDOW);
  if (list.length) buckets.set(key, list); else buckets.delete(key);
  return list;
};
/* Прибираємо лише протухле. Раніше на переповненні чистили все підряд —
   разом із чужими лічильниками, і ліміт скидався для всіх. */
function sweep() {
  if (buckets.size < 20000) return;
  for (const key of [...buckets.keys()]) fresh(key);
}
/* Чи вичерпано ліміт. Нічого не записує — перевірку і запис розділено,
   щоб відмова не з'їдала спробу. */
function overLimit(bucket, ip, max) {
  sweep();
  return fresh(bucket + ':' + ip).length >= max;
}
function countHit(bucket, ip) {
  const key = bucket + ':' + ip;
  const list = fresh(key);
  list.push(Date.now());
  buckets.set(key, list);
}
/* Читання рахуємо одразу: там кожен запит і є навантаженням. */
function tooOften(bucket, ip, max) {
  if (overLimit(bucket, ip, max)) return true;
  countHit(bucket, ip);
  return false;
}

/* Скільки запитів за 10 хвилин дозволяємо з однієї адреси.
   Статус свого замовлення сайт питає раз на 15 секунд — це 40 за вікно,
   тож ліміт вищий; перебрати ним усі номери замовлень уже не вийде. */
/* Сайт питає статус раз на 15 секунд, і той, хто увійшов, разом із ним
   питає своє активне замовлення — це вже 80 запитів за вікно. Плюс
   пробудження вкладки. Тому ліміт вищий, ніж був. */
const RATE = { order: 5, status: 300, history: 20, auth: 10, poll: 120, grill: 120, popular: 60 };

/* ---------- завантаження мангала ----------
   Мангал тягне близько 15 кг за годину (власник, 19.09), але частину
   цього зʼїдають ті, хто прийшов на точку чи подзвонив, — їх сайт не
   бачить. Тому сайту віддано 10 кг на годину, решта лишається точці.
   Коли мангал і так завалений, оператор у чаті точки командою /mangal
   закриває найближчі години. */
const HOUR = 3600e3;
const GRILL_CAP_G = Number(process.env.GRILL_CAP_G || 10000);
const hourFloor = ms => Math.floor(ms / HOUR) * HOUR;
/* Railway живе за UTC, а точка — за київським часом. Рахуємо не
   абсолютний час, а скільки лишилось до закриття. */
const kyivNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
function tillCloseMs() {
  const k = kyivNow();
  const close = (k.getDay() === 0 ? 19 : 20) * 60;
  return Math.max(0, close - (k.getHours() * 60 + k.getMinutes())) * 60000;
}
/* Надбавка на конкретну годину: мангальщики сказали, що встигнуть
   більше, ніж ліміт сайту, — оператор додає кілограми кнопкою в боті. */
const extraOf = shop => {
  const all = (db.extra || {})[shop] || {}, out = {}, from = hourFloor(Date.now());
  for (const k in all) if (Number(k) >= from && all[k] > 0) out[k] = all[k];
  return out;
};
const capOf = (shop, slot) => GRILL_CAP_G + (extraOf(shop)[hourFloor(slot)] || 0);
const grillBusyUntil = shop => {
  const t = (db.busy || {})[shop] || 0;
  return t > Date.now() ? t : 0;
};
/* Скільки сирого мʼяса вже записано на кожну годину цієї точки */
function grillLoad(shop) {
  const out = {}, from = hourFloor(Date.now());
  for (const no in db.orders) {
    const o = db.orders[no];
    /* Скасоване мангал не займає — саме для цього оператор і тисне «Скасувати» */
    if (o.shop !== shop || !o.fry || !o.slotAt || o.slotAt < from || o.status === CANCELED) continue;
    const key = hourFloor(o.slotAt);
    out[key] = (out[key] || 0) + (o.fg || 0);
  }
  return out;
}
/* Чому година не підходить. null — підходить. */
function grillRefuse(shop, slotAt, fg) {
  if (!slotAt) return null;                       // старий клієнт без часу — не чіпаємо
  if (slotAt < grillBusyUntil(shop)) return 'Мангал на цей час зайнятий. Оберіть пізніший час.';
  const cap = capOf(shop, slotAt);
  const used = grillLoad(shop)[hourFloor(slotAt)] || 0;
  if (used + Math.min(fg, cap) > cap) {
    return 'На цю годину мангал уже завантажений. Оберіть інший час.';
  }
  return null;
}

app.get('/api/grill', (req, res) => {
  if (tooOften('grill', ipOf(req), RATE.grill)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  let shop = Number(req.query.shop);
  if (!Number.isInteger(shop) || shop < 0 || shop >= SHOPS.length) shop = 0;
  res.json({ ok: true, cap: GRILL_CAP_G, extra: extraOf(shop),
    busyUntil: grillBusyUntil(shop), load: grillLoad(shop) });
});

/* Беремо ОСТАННЮ адресу зі списку, а не першу. Перша — та, яку надіслав
   сам клієнт, і нею можна було б обходити ліміти; останню дописує
   проксі хостингу. Railway свій заголовок і так перезаписує, але
   покладатися на це не варто. */
const ipOf = req => {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',');
  return chain[chain.length - 1].trim() || req.socket.remoteAddress || 'unknown';
};

/* ---------- приймання замовлення з сайту ---------- */
app.post('/api/order', async (req, res) => {
  const b = req.body || {};

  /* Перевіряємо, але ще не рахуємо: спробу зарахуємо лише коли замовлення
     справді пішло на точку. Інакше пʼять відмов (скажімо, точка не
     підключена) замикали людину на десять хвилин. */
  const ip = ipOf(req);
  if (overLimit('order', ip, RATE.order)) {
    return res.status(429).json({ error: 'Забагато замовлень поспіль. Зачекайте кілька хвилин.' });
  }

  const nm = String(b.nm || '').trim().slice(0, 60);
  /* Хто увійшов — того номер і беремо, а не той, що прийшов у запиті.
     Номер підтверджений Telegram, і саме за ним збирається історія:
     помилка в цифрі чи чужий номер у полі розірвали б її надвоє. */
  const who = authOf(req);
  const telKey = who ? who.telKey : normTel(b.tel);
  if (nm.length < 2 || telKey.length !== 9) {
    return res.status(400).json({ error: 'Вкажіть імʼя та коректний номер телефону' });
  }
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 40) {
    return res.status(400).json({ error: 'Некоректний склад замовлення' });
  }
  /* Склад і суму рахуємо самі, за прайсом. З браузера беремо лише
     номер позиції та кількість — ціну він міг би підмінити. */
  const lines = [];
  /* Смаження тепер позначають на кожній позиції. Сторінка зі старого
     кеша надсилає один прапорець на все замовлення — тоді розуміємо
     його по-старому: смажимо все, що смажиться. */
  const perLine = b.lines.some(l => l && l.fry !== undefined);
  for (const raw of b.lines.slice(0, 40)) {
    const it = byId.get(String(raw.id || ''));
    if (!it) {
      return res.status(400).json({ error: 'У замовленні є позиція, якої немає в каталозі' });
    }
    const q = Math.floor(Number(raw.g) || 0);
    const minQ = it.unit === 'вага' ? it.minG : 1;
    const maxQ = it.unit === 'вага' ? 20000 : 99;
    if (!(q >= minQ) || q > maxQ) {
      return res.status(400).json({ error: `Некоректна кількість: ${it.name}` });
    }
    /* Різновид (який саме соус) — лише зі списку в catalog.js. Сторінка
       зі старого кеша різновиду не надсилає: такий рядок приймаємо, як
       і раніше, просто без назви соусу. */
    let v = '';
    const vs = variantsOf(it);
    if (vs && raw.v) {
      v = String(raw.v);
      if (!vs.list.some(x => x[0] === v)) {
        return res.status(400).json({ error: `Такого різновиду немає: ${it.name}` });
      }
    }
    lines.push({
      name: it.name, grp: it.grp, cat: it.cat, unit: it.unit, id: it.id,
      g: q, sum: lineSum({ unit: it.unit, price: priceOf(it, v), g: q, grp: it.grp, name: it.name }),   // у соусів ціна своя; група й назва — для ваги упаковки
      fry: canFry(it) && (perLine ? !!raw.fry : !!b.fry),
      ...(v ? { v } : {})
    });
  }

  const goods = kop(lines.reduce((s, l) => s + l.sum, 0));
  const fg = lines.reduce((s, l) => s + (l.fry ? fryableG(l) : 0), 0);
  const fry = fg >= MIN_G;                     // смаження лише коли є що смажити
  const fryCost = fry ? kop(fg / 1000 * FRY_RATE) : 0;
  const total = kop(goods + fryCost);
  if (total <= 0 || total > 200000) {
    return res.status(400).json({ error: 'Некоректна сума замовлення' });
  }

  /* Розбіжність означає або підміну, або застарілий кеш сайту
     після зміни цін. Оператору краще знати. */
  const claimed = Number(b.total);
  const mismatch = Number.isFinite(claimed) && Math.abs(claimed - total) > 0.01
    ? kop(claimed) : null;
  if (mismatch !== null) {
    console.warn('Сума з браузера', mismatch, 'не збігається з прайсом', total, '· IP', ip);
  }

  let shopIndex = Number.isInteger(b.shop) ? b.shop : 0;
  if (b.shopName) {
    const byName = SHOPS.indexOf(b.shopName);
    if (byName > -1) shopIndex = byName;      // назва точніша за індекс
  }
  if (shopIndex < 0 || shopIndex >= SHOPS.length) shopIndex = 0;
  const chatId = db.shops[shopIndex];
  if (!chatId) {
    return res.status(503).json({
      error: 'Точка ще не підключена до Telegram',
      hint: `Надішліть боту /bind ${shopIndex + 1} КОД у потрібному чаті`
    });
  }

  /* Позицію могли зняти, поки людина набирала кошик. Кажемо, чого саме
     немає: «замовлення не прийнято» без пояснення — найгірше, що можна
     показати людині з повним кошиком. */
  const gone = lines.filter(l => isStopped(shopIndex, l.id)).map(l => nameOf(l));
  if (gone.length) {
    return res.status(409).json({
      error: `Сьогодні вже немає: ${gone.join(', ')}. Приберіть з кошика — решту приймемо.`,
      gone: lines.filter(l => isStopped(shopIndex, l.id)).map(l => l.id)
    });
  }

  /* Година, на яку записується мангал. Сайт рахує те саме, але
     перевіряємо тут: поки людина заповнювала форму, годину могли
     розібрати, та й запит до API можна надіслати повз сайт. */
  /* Час видачі тримаємо точний — сайт дає його з кроком у пів години.
     Раніше ми округлювали до години, і «17:30» ставало «17:00»: на
     доставці це зайвих пів години очікування (власник, 23.09). Мангал
     як рахувався погодинно, так і рахується — там своє округлення. */
  const slotAt = Number.isFinite(b.slotAt) && b.slotAt > Date.now() - HOUR
    ? Math.round(b.slotAt / 60000) * 60000 : 0;
  if (fry) {
    const refuse = grillRefuse(shopIndex, slotAt, fg);
    if (refuse) return res.status(409).json({ error: refuse });
  }

  const no = ++db.counter;
  const o = {
    no,
    status: 'new',
    shop: shopIndex,
    shopName: SHOPS[shopIndex],
    mode: b.mode === 'delivery' ? 'delivery' : 'pickup',
    addr: String(b.addr || '').slice(0, 200),
    addrParts: addrParts(b.addrParts),
    fry,
    fg,
    mismatch,
    /* 'online' навмисно не приймаємо: онлайн-оплати ще немає, і позначка
       «оплачено» у чаті точки означала б гроші, яких ніхто не отримував. */
    /* Картка — лише на точці: термінал там, а не в курʼєра. Запит повз
       сайт із 'card' на доставці приймаємо як готівку, а не відмовляємо:
       людина ні в чому не винна, а оператор побачить правильний спосіб. */
    pay: (b.mode === 'delivery' ? b.pay === 'cash' : ['cash','card'].includes(b.pay)) ? b.pay : 'cash',
    nm,
    tel: '+380' + telKey,
    telKey,
    note: String(b.note || '').slice(0, 400),
    when: String(b.when || '').slice(0, 80),
    slotAt,
    /* Ключ підтвердження отримання. Номери замовлень ідуть підряд,
       тож без нього «я отримав» міг би натиснути будь-хто, просто
       перебравши номери. Ключ віддаємо лише тому, хто замовляв. */
    ckey: crypto.randomBytes(6).toString('hex'),
    lines,
    total,
    createdAt: Date.now()
  };
  /* Спершу надсилаємо на точку і лише потім записуємо. Раніше було
     навпаки: якщо бот не доставив повідомлення, клієнт бачив помилку,
     а замовлення лишалося в базі й потім спливало в його історії як
     справжнє, хоча точка його не бачила. */
  let sent;
  try {
    sent = await bot.sendMessage(chatId, orderText(o), {
      parse_mode: 'HTML',
      reply_markup: keyboard(o)
    });
  } catch (e) {
    const detail = (e.response && e.response.body && e.response.body.description) || e.message;
    /* Раніше в лог летіло все замовлення цілком — разом з іменем,
       телефоном і адресою доставки. Для розбору польотів досить суми,
       складу й способу отримання; телефон — під маскою. */
    console.error('Telegram error:', detail, '· замовлення не збережено:',
      JSON.stringify({ shop: o.shopName, mode: o.mode, total: o.total, fry: o.fg,
        tel: telLog(o.tel), lines: o.lines.map(l => `${l.name} ${l.g}`) }));
    /* Номер не повертаємо: поки чекали на Telegram, його міг зайняти
       наступний клієнт. Пропуск у нумерації нікому не заважає. */
    return res.status(500).json({ error: 'Не вдалося передати замовлення на точку', detail });
  }

  o.msgId = sent.message_id;
  o.chatId = chatId;
  db.orders[no] = o;
  /* Запамʼятовуємо імʼя й адресу тому, хто увійшов: наступного разу
     форма буде вже заповнена. */
  if (who) {
    const u = db.users[who.telKey] || { telKey: who.telKey, createdAt: Date.now() };
    u.tel = o.tel;
    u.name = nm;
    if (o.mode === 'delivery' && o.addr) {
      u.addr = o.addr;
      u.addrParts = o.addrParts;
      /* Три останні адреси: люди возять то додому, то на роботу,
         то батькам. Однакові не дублюємо — свіжа йде першою. */
      u.addrs = [{ text: o.addr, parts: o.addrParts, at: Date.now() }]
        .concat((u.addrs || []).filter(a => a && a.text !== o.addr))
        .slice(0, 3);
    }
    u.lastSeen = Date.now();
    db.users[who.telKey] = u;
  }
  save();
  countHit('order', ip);                       // зараховуємо лише те, що дійшло
  res.json({ ok: true, no, status: o.status, total: o.total, ckey: o.ckey });
});

/* ---------- статус для сайту ---------- */
/* ---------- клієнт підтверджує отримання ----------
   Оператор фізично бачить лише передачу курʼєру, а отримання — клієнт.
   Тому «Доставлено» тисне саме він: кнопкою в сповіщенні бота або на
   сторінці замовлення. За оператором лишається запасна кнопка — для
   тих, хто не підтвердив. */
function markReceived(o, by) {
  o.status = 'done';
  o.gotBy = by;                       // 'клієнт' або імʼя оператора
  o.updatedAt = Date.now();
  dropRemind(o);
  save();
  bot.editMessageText(orderText(o), {
    chat_id: o.chatId, message_id: o.msgId, parse_mode: 'HTML', reply_markup: keyboard(o)
  }).catch(() => {});
  if (by === 'клієнт') {
    bot.sendMessage(o.chatId, `✅ Клієнт підтвердив, що отримав замовлення № ${o.no}.`,
      { reply_to_message_id: o.msgId }).catch(() => {});
  }
}
/* Чи можна зараз підтверджувати отримання */
function receivable(o) {
  if (o.status === CANCELED) return 'Замовлення скасовано';
  if (o.status === 'done') return 'ok';
  if (o.mode === 'delivery') return o.status === 'onway' ? null : 'Курʼєр ще не виїхав';
  /* Самовивіз віддають із рук у руки — там «Видано» тисне точка */
  return 'Самовивіз відмічає точка на місці';
}

app.post('/api/order/:no/received', (req, res) => {
  if (tooOften('status', ipOf(req), RATE.status)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const o = db.orders[req.params.no];
  if (!o) return res.status(404).json({ error: 'Замовлення не знайдено' });
  const a = authOf(req);
  const mine = (a && a.telKey === o.telKey) ||
               (o.ckey && req.body && req.body.key === o.ckey);
  if (!mine) return res.status(403).json({ error: 'Це замовлення оформили не з цього пристрою' });
  const why = receivable(o);
  if (why === 'ok') return res.json({ ok: true, status: 'done' });
  if (why) return res.status(409).json({ error: why });
  markReceived(o, 'клієнт');
  res.json({ ok: true, status: 'done' });
});

app.get('/api/order/:no', (req, res) => {
  /* Номери йдуть підряд, тож без ліміту їх можна було б просто перебрати
     і побачити суми всіх замовлень магазину. */
  if (tooOften('status', ipOf(req), RATE.status)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const o = db.orders[req.params.no];
  if (!o) return res.status(404).json({ error: 'Замовлення не знайдено' });
  /* slotAt — щоб сайт знав, що замовлення на інший день, і не писав
     «готується» напередодні. Часу видачі й так не секрет. */
  res.json({ no: o.no, status: o.status, label: LABEL[o.status], total: o.total, mode: o.mode, slotAt: o.slotAt || 0,
             ...(adjustmentsOf(o).length ? { totalOrig: o.totalOrig, adjust: pubAdjust(o) } : {}) });   // зміни оператора
});

/* ---------- «сьогодні немає» ----------
   Мʼясо закінчується серед дня, і людина дізнавалась про це вже по
   телефону від оператора — розмова з тих, що псують день обом
   (власник, 22.09). Тепер точка тисне в боті «🚫 Немає», і позиція
   гасне на сайті: картка лишається сірою, без кнопки.

   Список у кожної точки свій: у Шевченка закінчився ошийок, а на
   Свободі він є. Відмітка діє до ранку — о 8:00 усе повертається саме,
   бо інакше хтось забуде натиснути «є» і точка торгуватиме половиною
   меню. */
const OPEN_HOUR = 8;
/* Наступне відкриття в абсолютному часі: сервер живе за UTC, точка — за
   київським, тому рахуємо різницю, а не годину напряму. */
function nextOpenMs() {
  const k = kyivNow(), d = new Date(k);
  if (k.getHours() >= OPEN_HOUR) d.setDate(d.getDate() + 1);
  d.setHours(OPEN_HOUR, 0, 0, 0);
  return Date.now() + (d - k);
}
/* Те, чого немає саме зараз: протухлі відмітки не рахуємо й не чистимо
   окремо — вони відпадають самі. */
function stopOf(shop) {
  const all = (db.stop || {})[shop] || {}, now = Date.now(), out = {};
  for (const id in all) if (all[id] > now) out[id] = all[id];
  return out;
}
const isStopped = (shop, id) => !!stopOf(shop)[id];
/* Пошук позиції за назвою для команди /stop: «ошийок», «стейк» */
const foldName = s => String(s || '').toLowerCase().replace(/[ʼ'’`]/g, '');
const findItems = q => {
  const f = foldName(q);
  if (f.length < 2) return [];
  return CATALOG.ITEMS.filter(i => foldName(i.grp + ' ' + i.name).includes(f)).slice(0, 8);
};

app.get('/api/stock', (req, res) => {
  if (tooOften('grill', ipOf(req), RATE.grill)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  let shop = Number(req.query.shop);
  if (!Number.isInteger(shop) || shop < 0 || shop >= SHOPS.length) shop = 0;
  res.json({ ok: true, off: Object.keys(stopOf(shop)) });
});

/* ---------- що беруть найчастіше ----------
   Вкладка «Популярне» на сайті. Рахуємо по справжніх замовленнях за
   останній місяць, а не по вподобайках: накрутити не можна, і це
   справді те, що люди купують. Одне замовлення — один голос за позицію,
   скільки б грамів у ньому не було: інакше нагорі назавжди осіла б
   курка гриль, яку беруть цілою тушкою. */
const POPULAR_DAYS = 30;
const POPULAR_MAX = 12;
/* Поки замовлень одиниці, «Популярне» — це просто чийсь один кошик.
   23.09 туди потрапили сім позицій із єдиного тестового замовлення,
   кожна по разу. Доки не набереться хоч пʼять замовлень, вкладки краще
   не показувати зовсім. */
const POPULAR_MIN_ORDERS = 5;
function popularIds() {
  const edge = Date.now() - POPULAR_DAYS * 24 * 3600 * 1000;
  const cnt = {};
  let liveOrders = 0;
  for (const no in db.orders) {
    const o = db.orders[no];
    if ((o.createdAt || 0) < edge || o.status === CANCELED) continue;
    liveOrders++;
    const seen = new Set();
    for (const l of (o.lines || [])) {
      /* Замовлення з давніх часів пам'ятають номери старого зразка
         ('p0'), і таких позицій у прайсі вже немає — сайт їх однаково
         не покаже, а місце в топі вони займали. */
      if (!l.id || seen.has(l.id) || !byId.has(l.id)) continue;
      seen.add(l.id);
      cnt[l.id] = (cnt[l.id] || 0) + 1;
    }
  }
  if (liveOrders < POPULAR_MIN_ORDERS) return [];   // замало замовлень, щоб казати «популярне»
  return Object.entries(cnt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, POPULAR_MAX)
    .map(([id, n]) => ({ id, n }));
}

app.get('/api/popular', (req, res) => {
  if (tooOften('popular', ipOf(req), RATE.popular)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  res.json({ ok: true, days: POPULAR_DAYS, top: popularIds() });
});

/* ---------- вхід ---------- */
/* Сайт просить ключ і веде людину до бота. Ключ випадковий і живе
   пʼять хвилин: за посиланням, яке хтось підгляне пізніше, увійти
   не вийде. */
app.post('/api/auth/start', (req, res) => {
  if (tooOften('auth', ipOf(req), RATE.auth)) {
    return res.status(429).json({ error: 'Забагато спроб. Зачекайте кілька хвилин.' });
  }
  if (!BOT_NAME) {
    return res.status(503).json({ error: 'Вхід тимчасово недоступний. Спробуйте пізніше.' });
  }
  sweepLogins();
  const sid = crypto.randomBytes(16).toString('hex');
  logins.set(sid, { at: Date.now(), status: 'wait' });
  res.json({
    ok: true, sid,
    link: `https://t.me/${BOT_NAME}?start=${sid}`,
    ttl: Math.round(AUTH_TTL / 1000)
  });
});

/* Сайт питає, чи вже поділилися номером. Токен віддаємо один раз:
   другий запит із тим самим ключем нічого не дасть. */
app.get('/api/auth/poll/:sid', (req, res) => {
  if (tooOften('poll', ipOf(req), RATE.poll)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const s = logins.get(String(req.params.sid || ''));
  if (!s || Date.now() - s.at > AUTH_TTL) return res.json({ ok: true, status: 'expired' });
  if (s.status !== 'ok') return res.json({ ok: true, status: 'wait' });

  logins.delete(String(req.params.sid));
  if (s.chatId) chatLogin.delete(s.chatId);
  const u = db.users[s.telKey] || {};
  res.json({ ok: true, status: 'ok', token: s.token, tel: u.tel || ('+380' + s.telKey),
    name: u.name || '', addr: u.addr || '', addrParts: u.addrParts || null, addrs: u.addrs || [],
    favs: u.favs || [] });
});

app.post('/api/auth/logout', (req, res) => {
  const a = authOf(req);
  if (a) { delete db.tokens[a.token]; save(); }
  res.json({ ok: true });
});

/* ---------- профіль ---------- */
app.get('/api/me', (req, res) => {
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібно увійти' });
  const u = a.user;
  res.json({ ok: true, tel: u.tel || ('+380' + a.telKey), name: u.name || '',
    addr: u.addr || '', addrParts: u.addrParts || null, addrs: u.addrs || [],
    favs: u.favs || [] });
});

/* Обране тримаємо в покупця, а не лише в браузері: людина обирає на
   телефоні, а замовляє з компʼютера. Номери позицій беремо як є —
   зняті з продажу сайт просто не покаже. */
const FAVS_MAX = 200;
const cleanFavs = raw => Array.isArray(raw)
  ? [...new Set(raw.filter(x => typeof x === 'string' && x.length < 24))].slice(0, FAVS_MAX)
  : null;

app.put('/api/me', (req, res) => {
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібно увійти' });
  const b = req.body || {};
  const u = db.users[a.telKey] || { telKey: a.telKey, createdAt: Date.now() };
  /* Номер міняти не даємо: він підтверджений Telegram і тримає всю
     історію. Потрібен інший — це інший вхід. */
  u.tel = '+380' + a.telKey;
  if (b.name !== undefined) u.name = String(b.name).trim().slice(0, 60);
  if (b.addr !== undefined) u.addr = String(b.addr).trim().slice(0, 200);
  if (b.favs !== undefined) { const f = cleanFavs(b.favs); if (f) u.favs = f; }
  u.lastSeen = Date.now();
  db.users[a.telKey] = u;
  save();
  res.json({ ok: true, tel: u.tel, name: u.name || '', addr: u.addr || '',
    addrParts: u.addrParts || null, addrs: u.addrs || [], favs: u.favs || [] });
});

/* ---------- історія замовлень ---------- */
/* Раніше історію віддавали будь-кому, хто ввів номер: чужі замовлення
   читалися перебором. Тепер лише своя, за токеном. */
/* Що з замовлення можна показувати власнику. Імені й адреси тут немає
   навмисно: вони й так його, але у відповіді їм робити нічого. */
const pubOrder = o => ({
  no: o.no,
  status: o.status,
  label: LABEL[o.status],
  createdAt: o.createdAt,
  shopName: o.shopName,
  mode: o.mode,
  fry: o.fry,
  fg: o.fg || 0,
  when: o.when || '',
  slotAt: o.slotAt || 0,            // сайту — щоб не обіцяв «готується» напередодні
  total: o.total,
  ...(adjustmentsOf(o).length ? { totalOrig: o.totalOrig, adjust: pubAdjust(o) } : {}),
  lines: Array.isArray(o.lines) ? o.lines : []
});
/* Адреса приходить і рядком (для чату точки), і частинами — щоб наступного
   разу підставити її в ті самі поля. Беремо лише відомі ключі й коротко:
   решта з браузера нас не цікавить. */
const ADDR_KEYS = ['street', 'house', 'flat', 'ent', 'floor'];
function addrParts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  /* Лише рядки й числа: обʼєкт із браузера перетворився б на
     «[object Object]» і поїхав курʼєру в адресі. */
  for (const k of ADDR_KEYS) {
    const v = raw[k];
    out[k] = (typeof v === 'string' || typeof v === 'number') ? String(v).trim().slice(0, 40) : '';
  }
  return out.street || out.house ? out : null;
}

const ordersOf = telKey => Object.values(db.orders)
  .filter(o => (o.telKey || normTel(o.tel)) === telKey)
  .sort((a, b) => b.createdAt - a.createdAt);

function historyOf(telKey) {
  const MAX_AGE = 60 * 24 * 3600 * 1000;   // 60 днів
  return ordersOf(telKey)
    .filter(o => Date.now() - (o.createdAt || 0) < MAX_AGE)
    .slice(0, 10)
    .map(pubOrder);
}

/* Замовлення, яке зараз готують. Сайт показує смужку «стежити» вгорі:
   раніше він знав про неї лише з памʼяті браузера, тож на іншому
   телефоні — навіть своєму — замовлення не було видно взагалі. */
app.get('/api/me/active', (req, res) => {
  if (tooOften('status', ipOf(req), RATE.status)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібно увійти' });
  const DAY = 24 * 3600 * 1000;
  /* Замовлень у роботі буває кілька: шашлик на вечір і самовивіз на
     іншій точці. Раніше віддавали лише найсвіжіше, і на сайті нове
     замовлення закривало собою попереднє.
     Замовлення «на завтра» живе довше доби, тож тримаємо його, поки не
     мине година видачі: інакше воно зникало б саме тоді, коли по нього
     треба їхати. */
  const live = o => !FINAL.has(o.status) &&
    (Date.now() - (o.createdAt || 0) < DAY ||
     (o.slotAt && Date.now() < o.slotAt + 6 * 3600 * 1000));
  const list = ordersOf(a.telKey).filter(live)
    .sort((x, y) => (x.slotAt || x.createdAt || 0) - (y.slotAt || y.createdAt || 0))
    .slice(0, 3);
  /* order — для сторінок, які лежать у кеші з минулої версії */
  res.json({ ok: true, order: list[0] ? pubOrder(list[0]) : null, orders: list.map(pubOrder) });
});

app.get('/api/me/orders', (req, res) => {
  if (tooOften('history', ipOf(req), RATE.history)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібно увійти' });
  const list = historyOf(a.telKey);
  res.json({ ok: true, count: list.length, orders: list });
});

/* Стара адреса лишається для сторінок із кеша — але вже під токеном
   і лише для власного номера. */
app.get('/api/history/:tel', (req, res) => {
  if (tooOften('history', ipOf(req), RATE.history)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const a = authOf(req);
  if (!a) return res.status(401).json({ error: 'Потрібно увійти' });
  if (normTel(req.params.tel) !== a.telKey) {
    return res.status(403).json({ error: 'Це чужий номер' });
  }
  const list = historyOf(a.telKey);
  res.json({ ok: true, count: list.length, orders: list });
});

/* ---------- зміна статусу оператором ---------- */
/* ---------- один шлях для зміни статусу ----------
   Кнопку тисне і оператор у чаті, і оператор у панелі на планшеті. Якщо
   тримати дві копії правил, вони розійдуться — і хтось один почне
   готувати наперед або відкочувати статус назад. Тому всі перевірки
   тут, а бот із панеллю лише кличуть.
   Повертає {ok:true} або {err:'чому не можна'}. */
/* Картка в чаті точки — спільна пам'ять про замовлення, тож її оновлюють
   усі, хто щось змінив: і бот, і панель. */
const editCard = o => bot.editMessageText(orderText(o), {
  chat_id: o.chatId, message_id: o.msgId, parse_mode: 'HTML', reply_markup: keyboard(o)
}).catch(e => console.error('edit:', e.message));

/* Зміна суми, коментар і скасування — теж в одному місці, як і статуси.
   Панель робить це формою в картці, бот — відповіддю на повідомлення,
   але правила однакові: що можна міняти й до якого стану.
   Повертає {ok:true, prevShip} або {err:'чому не можна'}. */
async function applyAdjust(o, kind, amount, note, by) {
  if (!canEdit(o, kind)) return { err: lockedText(kind) };

  /* Скасування — не зміна суми: замовлення виходить із ланцюжка, кнопки
     зникають, а зайнята година на мангалі звільняється сама (скасовані
     grillLoad не рахує). */
  if (kind === 'cancel') {
    if (!note) return { err: 'Потрібна причина — її побачить клієнт' };
    o.adjust = adjustmentsOf(o).slice();
    o.adjust.push({ kind: 'cancel', note, by, at: Date.now(), from: o.status });
    o.status = CANCELED;
    dropRemind(o);
    o.updatedAt = Date.now();
    save();
    await editCard(o);
    notifyCancel(o, note);
    return { ok: true };
  }

  /* Суму рахуємо від поточної, а не від тієї, що була в момент запиту:
     між запитом і підтвердженням міг устигнути інший оператор. */
  const before = o.total;
  const next = nextTotal(before, kind, amount, o);
  if (kind !== 'note' && (!(amount > 0) || next <= 0 || next > MAX_TOTAL)) {
    return { err: `Сума вийшла б ${money(next)} — так не можна.` };
  }

  const prevShip = o.ship || 0;                    // попередня доставка — щоб показати «було»
  o.adjust = adjustmentsOf(o).slice();              // стара одна зміна стає першою в списку
  if (o.totalOrig == null) o.totalOrig = o.total;   // сума з сайту лишається назавжди
  o.adjust.push({ kind, amount, note, by, at: Date.now(),
                  ...(kind === 'fact' ? { from: before } : {}),   // факт — з чого перейшли
                  ...(kind === 'ship' ? { from: prevShip } : {}) });
  if (kind === 'ship') o.ship = amount;            // тримаємо окремо: наступна доставка замінить цю
  o.total = next;
  delete o.totalNote; delete o.totalBy; delete o.totalAt;
  o.updatedAt = Date.now();
  save();

  await editCard(o);
  notifyAdjust(o, o.adjust[o.adjust.length - 1]);
  return { ok: true, prevShip };
}

async function applyStatus(o, st) {
  if (!STATUSES.includes(st)) return { err: 'Невідомий статус' };
  /* Готувати наперед не можна: на завтра оператор лише «Приймає в
     роботу», решта кнопок оживає того дня (власник, 20.09 — заказ на
     завтра всю ніч висів у клієнта як «Готується»). */
  if (st !== 'accepted' && futureDay(o)) {
    return { err: `Замовлення на ${dayShort(o.slotAt)}. Готувати й видавати — того дня.` };
  }
  /* Те саме в межах дня. О десятій ранку можна було натиснути всі кнопки
     на замовлення, яке заберуть о пʼятій, — і мʼясо чекало б сім годин
     (власник, 23.09). Доставку відкриваємо за півтори години, самовивіз
     за годину. */
  if (st !== 'accepted' && o.slotAt) {
    const from = o.slotAt - (o.mode === 'delivery' ? 90 : 60) * 60000;
    if (Date.now() < from) {
      return { err: `Замовлення на ${hhmm(o.slotAt)}. Братися можна з ${hhmm(from)}.` };
    }
  }
  /* Статус іде лише вперед, на один крок. Старе повідомлення чи швидкий
     подвійний дотик натискали кнопку, якої вже не мало бути, — і
     «Готове» відкочувалось назад у «Готується», у клієнта теж. */
  if (!nextBtns(o).some(([next]) => next === st)) {
    return { err: `Уже «${LABEL[o.status]}»`, stale: true };
  }

  o.status = st;
  if (st === 'onway') o.onwayAt = Date.now();   // від цієї миті рахуємо дві години
  if (st === 'ready') o.readyAt = Date.now();   // від цієї — нагадування про самовивіз
  dropRemind(o);                  // взяли в роботу — нагадування зайве
  o.updatedAt = Date.now();
  save();

  /* Картка в чаті точки — спільна пам'ять зміни, тож оновлюємо її
     незалежно від того, звідки натиснули. */
  await bot.editMessageText(orderText(o), {
    chat_id: o.chatId,
    message_id: o.msgId,
    parse_mode: 'HTML',
    reply_markup: keyboard(o)
  }).catch(e => console.error('edit:', e.message));

  notify(o, st);
  return { ok: true };
}

bot.on('callback_query', async cq => {
  const [tag, noStr, st] = (cq.data || '').split(':');
  if (tag !== 's') return;

  const o = db.orders[noStr];
  if (!o) return bot.answerCallbackQuery(cq.id, { text: 'Замовлення не знайдено' });
  /* Лише в чаті тієї точки, куди прийшло замовлення */
  if (cq.message && cq.message.chat.id !== o.chatId) {
    return bot.answerCallbackQuery(cq.id, { text: 'Це замовлення іншої точки' });
  }

  const r = await applyStatus(o, st);
  if (r.err) {
    if (r.stale) {
      await bot.editMessageReplyMarkup(keyboard(o), { chat_id: o.chatId, message_id: o.msgId }).catch(() => {});
      return bot.answerCallbackQuery(cq.id, { text: r.err + ' — кнопки оновлено' });
    }
    return bot.answerCallbackQuery(cq.id, { text: r.err, show_alert: true });
  }

  await bot.answerCallbackQuery(cq.id, { text: LABEL[st] });
});

/* ---------- оператор уточнює суму ----------
   Сума на сайті орієнтовна: мʼясо важать під замовлення, а клієнт може
   щось додати телефоном. Суму оператор міняє лише кнопками:
     🧾 Фактична сума — число з каси, де замовлення пробили й зважили;
                       коментар за потреби («замість ошийка поклали мʼякоть»)
     ➕ Додати  — «39 додали соус Ткемалі»: до суми додається 39
     ➖ Відняти — «20 вага менша»: від суми віднімається 20
     💬 Коментар — лише текст для клієнта, сума не міняється
   Просто написати нову суму не можна — так «441» замість «+39» колись
   зменшило суму, хоча в коментарі стояло «додали».
   Кожну зміну бот перепитує. Усе це — лише до «Готується».
   У групі бот бачить тільки відповіді на свої повідомлення, тому запит
   іде з force_reply. */
const AMOUNT_TTL = 10 * 60 * 1000;
const MAX_TOTAL = 200000;
const amountAsks = new Map();          // "чат:повідомлення" → { no, kind, at }
const amountConfirms = new Map();      // ключ → { no, kind, amount, note, at }
setInterval(() => {
  const now = Date.now();
  for (const m of [amountAsks, amountConfirms])
    for (const [k, a] of m) if (now - a.at > AMOUNT_TTL) m.delete(k);
}, 60 * 1000).unref();

const opName = u => [u && u.first_name, u && u.last_name].filter(Boolean).join(' ') || 'оператор';

/* Нова сума після зміни: факт — як є, ➕ / ➖ — від поточної, коментар — без змін */
const nextTotal = (cur, kind, amount, o) =>
  kind === 'fact' ? kop(amount)
  : kind === 'ship' ? kop(cur - ((o && o.ship) || 0) + amount)   // доставка замінюється, а не додається двічі
  : kind === 'add' ? kop(cur + amount) : kind === 'sub' ? kop(cur - amount) : cur;
/* «+4.40 ₴» / «−15.90 ₴» / «без змін» */
const diffText = (from, to) => {
  const d = kop(to - from);
  return d ? `${d > 0 ? '+' : '−'}${money(Math.abs(d))}` : 'без змін';
};
/* Касова сума, що відрізняється від поточної більше ніж на 30%, — майже
   напевно опечатка: 38380 замість 383.80. Перепитуємо з попередженням. */
const FACT_WARN = 0.3;
const LOCKED_TEXT = 'Замовлення вже готується — суму й коментарі змінити не можна';

/* «39», «39,50 грн», «39 додали соус Ткемалі» → { amount, note }.
   Сума — перше число, решта — коментар. Слово «грн» коментарем не є. */
function parseTotalReply(t) {
  /* Пробіл усередині числа — лише як розділювач тисяч («1 250»): інакше
     «39 2 соуси» склеїлось би в 392. */
  const m = String(t || '').trim().match(/^((?:\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,]\d{1,2})?)\s*(?:грн\.?|₴|uah)?\s*(.*)$/i);
  if (!m) return { amount: NaN, note: '' };
  const amount = kop(Number(m[1].replace(/\s/g, '').replace(',', '.')));
  return { amount, note: m[2].trim().replace(/^[-—–:,.]\s*/, '').slice(0, 200) };
}

const ASK = {
  fact: o => `Замовлення № ${o.no}, зараз ${money(o.total)}.\n🧾 Введіть <b>фактичну суму з каси</b> разом зі смаженням — відповіддю на це повідомлення. За потреби — коментар через пробіл.\nНаприклад: 461.30 або 461.30 замість ошийка поклали мʼякоть`,
  add:  o => `Замовлення № ${o.no}, зараз ${money(o.total)}.\n➕ На скільки <b>збільшити</b> суму? Відповідайте на це повідомлення, коментар — через пробіл.\nНаприклад: 39 додали соус Ткемалі`,
  sub:  o => `Замовлення № ${o.no}, зараз ${money(o.total)}.\n➖ На скільки <b>зменшити</b> суму? Відповідайте на це повідомлення, коментар — через пробіл.\nНаприклад: 25 вага менша`,
  note: o => `Замовлення № ${o.no}.\n💬 Напишіть коментар для клієнта відповіддю на це повідомлення. Сума не зміниться.`,
  /* «, зараз …» — не прикраса: за цим початком бот упізнає власний
     запит, коли вже не памʼятає його (askFromText). Раніше тут стояло
     «№ 1024 — Нове», і відповідь із причиною після перезапуску сервера
     просто нікуди не йшла. */
  cancel: o => `Замовлення № ${o.no}, зараз «${LABEL[o.status]}».\n✖️ Напишіть <b>причину скасування</b> відповіддю на це повідомлення — її побачить клієнт.\nНаприклад: немає в наявності або клієнт відмовився`,
  ship: o => `Замовлення № ${o.no}, зараз ${money(o.total)}.\n🚕 Введіть <b>вартість доставки</b> — відповіддю на це повідомлення. За потреби — коментар через пробіл.\nНаприклад: 120 або 120 таксі до Салтівки` +
    (o.ship ? `\nЗараз у сумі вже є доставка ${money(o.ship)} — нова замінить її.` : '')
};

async function askAdjust(o, kind, chatId) {
  const ask = await bot.sendMessage(chatId, ASK[kind](o),
    { parse_mode: 'HTML', reply_markup: { force_reply: true }, reply_to_message_id: o.msgId });
  amountAsks.set(chatId + ':' + ask.message_id, { no: o.no, kind, at: Date.now() });
}

bot.on('callback_query', async cq => {
  const [tag, a1, a2] = (cq.data || '').split(':');
  const chatId = cq.message && cq.message.chat.id;

  /* Стара кнопка «⚖️ Змінити суму» в повідомленнях, надісланих до
     оновлення: підміняємо клавіатуру на нову. */
  if (tag === 't' || tag === 'tc' || tag === 'tx') {
    const old = tag === 't' && db.orders[a1];
    if (old && chatId === old.chatId) {
      await bot.editMessageReplyMarkup(keyboard(old), { chat_id: old.chatId, message_id: old.msgId }).catch(() => {});
    }
    return bot.answerCallbackQuery(cq.id, { text: 'Кнопку оновлено: тепер ➕ Додати, ➖ Відняти або 💬 Коментар' });
  }
  if (!['a', 'ac', 'ax'].includes(tag)) return;

  const conf = tag === 'a' ? null : amountConfirms.get(a1);
  if (tag !== 'a' && !conf) {
    return bot.answerCallbackQuery(cq.id, { text: 'Підтвердження застаріло — натисніть кнопку під замовленням ще раз' });
  }
  const o = db.orders[tag === 'a' ? a1 : conf.no];
  if (!o) return bot.answerCallbackQuery(cq.id, { text: 'Замовлення не знайдено' });
  /* Лише в чаті тієї точки, куди прийшло замовлення */
  if (chatId !== o.chatId) return bot.answerCallbackQuery(cq.id, { text: 'Це замовлення іншої точки' });
  const kind = tag === 'a' ? a2 : conf.kind;
  if (!canEdit(o, kind)) {
    if (tag !== 'a') {
      amountConfirms.delete(a1);
      await bot.editMessageText(`⛔ ${lockedText(kind)}.`, { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
    }
    return bot.answerCallbackQuery(cq.id, { text: lockedText(kind), show_alert: true });
  }

  if (tag === 'a') {
    if (!ASK[a2]) return bot.answerCallbackQuery(cq.id);
    await askAdjust(o, a2, chatId).catch(e => console.error('ask adjust:', e.message));
    return bot.answerCallbackQuery(cq.id);
  }

  amountConfirms.delete(a1);
  if (tag === 'ax') {
    await bot.editMessageText(`Зміну замовлення № ${o.no} скасовано.`,
      { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
    return bot.answerCallbackQuery(cq.id, { text: 'Скасовано' });
  }

  const before = o.total;
  const r = await applyAdjust(o, conf.kind, conf.amount, conf.note, opName(cq.from));
  if (r.err) {
    await bot.editMessageText(`⛔ ${r.err}`, { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
    return bot.answerCallbackQuery(cq.id, { text: r.err });
  }
  const next = o.total;
  await bot.editMessageText(
    conf.kind === 'cancel' ? `✖️ № ${o.no} скасовано: ${conf.note}`
    : conf.kind === 'ship' ? `✅ № ${o.no}: доставка ${money(conf.amount)}${r.prevShip ? ` (було ${money(r.prevShip)})` : ''}, разом ${money(next)}`
    : conf.kind === 'note' ? `✅ Коментар до № ${o.no} надіслано: ${conf.note}`
    : conf.kind === 'fact' ? `✅ № ${o.no}: фактична сума ${money(next)} (було ${money(before)}, ${diffText(before, next)})` + (conf.note ? `\n${conf.note}` : '')
    : `✅ № ${o.no}: ${money(before)} ${conf.kind === 'add' ? '+' : '−'} ${money(conf.amount)} = ${money(next)}` + (conf.note ? `\n${conf.note}` : ''),
    { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
  await bot.answerCallbackQuery(cq.id, { text: conf.kind === 'cancel' ? 'Скасовано' : 'Готово' });
});

/* Відповідь оператора на запит */
/* Запит, якого бот уже не памʼятає, — за текстом його ж повідомлення з ASK:
   «Замовлення № 1024, зараз … 🧾 Введіть…» → { no: 1024, kind: 'fact' } */
function askFromText(r) {
  if (!r || !r.from || !BOT_ID || r.from.id !== BOT_ID) return null;
  const t = String(r.text || '');
  /* Саме запит, а не картка замовлення: картка починається «Замовлення № N — Нове»
     і теж містить 🧾/➕, та відповідь на неї сумою не є */
  const m = t.match(/^Замовлення № (\d+)(?:, зараз |\.\n)/);
  if (!m || !/відповід/i.test(t)) return null;
  const kind = t.includes('🧾') ? 'fact' : t.includes('➕') ? 'add' : t.includes('➖') ? 'sub'
             : t.includes('✖️') ? 'cancel'
             : t.includes('🚕') ? 'ship'
             : t.includes('💬 Напишіть коментар') ? 'note' : null;
  return kind ? { no: Number(m[1]), kind, at: Date.now() } : null;
}

bot.on('message', async msg => {
  const r = msg.reply_to_message;
  if (!r || !msg.text) return;
  const key = msg.chat.id + ':' + r.message_id;
  /* Запит бот памʼятає лише в памʼяті процесу й лише до першої відповіді.
     Відповідь на той самий запит удруге або після перезапуску сервера
     раніше мовчки ігнорувалась — оператор думав, що чат завис. Тепер
     упізнаємо запит за текстом власного повідомлення бота. */
  const ask = amountAsks.get(key) || askFromText(r);
  if (!ask) return;
  amountAsks.delete(key);

  const o = db.orders[ask.no];
  if (!o || o.chatId !== msg.chat.id) return;
  if (!canEdit(o, ask.kind)) {
    return bot.sendMessage(msg.chat.id, `⛔ ${lockedText(ask.kind)}.`, { reply_to_message_id: msg.message_id }).catch(() => {});
  }

  let amount = 0, note = '';
  /* Коментар і скасування — це текст, а не сума */
  if (ask.kind === 'note' || ask.kind === 'cancel') {
    note = msg.text.trim().slice(0, 200);
    if (!note) return askAdjust(o, ask.kind, msg.chat.id).catch(() => {});
  } else {
    ({ amount, note } = parseTotalReply(msg.text));
    const next = nextTotal(o.total, ask.kind, amount, o);
    if (!(amount > 0) || next <= 0 || next > MAX_TOTAL) {
      await bot.sendMessage(msg.chat.id,
        !(amount > 0) ? 'Не вдалося розібрати суму: рядок має починатися з числа.'
                      : `Сума вийшла б ${money(next)} — так не можна.`,
        { reply_to_message_id: msg.message_id }).catch(() => {});
      return askAdjust(o, ask.kind, msg.chat.id).catch(() => {});
    }
  }

  /* Коментар у callback_data не влізе (ліміт 64 байти), тож
     підтвердження тримаємо тут, а в кнопці — короткий ключ. */
  const id = crypto.randomBytes(4).toString('hex');
  amountConfirms.set(id, { no: o.no, kind: ask.kind, amount, note, at: Date.now() });
  const next = nextTotal(o.total, ask.kind, amount, o);
  const far = ask.kind === 'fact' && Math.abs(next - o.total) > o.total * FACT_WARN;
  const preview = ask.kind === 'cancel'
    ? `✖️ № ${o.no} (${LABEL[o.status]}) — скасувати?\nПричина для клієнта: ${note}`
    : ask.kind === 'ship'
    ? `№ ${o.no}: доставка ${money(amount)}${o.ship ? ` замість ${money(o.ship)}` : ''}\n${money(o.total)} → ${money(next)}`
      + (note ? `\nКоментар для клієнта: ${note}` : '')
    : ask.kind === 'note' ? `№ ${o.no}: коментар для клієнта:\n${note}`
    : ask.kind === 'fact'
      ? `№ ${o.no}: фактична сума з каси\n${money(o.total)} → ${money(next)} (${diffText(o.total, next)})` +
        (note ? `\nКоментар для клієнта: ${note}` : '') +
        (far ? `\n⚠️ Різниця більше ${Math.round(FACT_WARN * 100)}% — перевірте, чи немає опечатки.` : '')
      : `№ ${o.no}: ${money(o.total)} ${ask.kind === 'add' ? '+' : '−'} ${money(amount)} = ${money(next)}` +
        (note ? `\nКоментар для клієнта: ${note}` : '');
  bot.sendMessage(msg.chat.id, preview + '\nПідтвердити?',
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Так', callback_data: `ac:${id}` },
      { text: 'Скасувати', callback_data: `ax:${id}` }
    ]] } }).catch(e => console.error('confirm adjust:', e.message));
});

/* Клієнту, який увійшов через Telegram, — про кожну зміну */
/* Про скасування пишемо окремо: це не зміна суми, а кінець замовлення.
   Тому й телефон точки поруч — щоб людина могла одразу перепитати. */
function notifyCancel(o, why) {
  const u = db.users[o.telKey] || {};
  const tel = (CATALOG_SHOPS[o.shop] || [])[1] || '';
  const text = `✖️ Замовлення № ${o.no} скасовано.\nПричина: ${why}` +
    (tel ? `\nЯкщо це непорозуміння — зателефонуйте: ${tel}` : '');
  if (!u.tgId) return console.log('[SMS →', telLog(o.tel) + ']', text.replace(/\n/g, ' '));
  bot.sendMessage(u.tgId, text, {
    reply_markup: { inline_keyboard: [[{ text: 'Відкрити замовлення', url: SITE + '?order=' + o.no }]] }
  }).catch(e => console.warn('Скасування № ' + o.no + ' не дійшло до клієнта:', e.message));
}

function notifyAdjust(o, a) {
  const u = db.users[o.telKey] || {};
  if (!u.tgId || !a) return;
  /* Про незмінну ціну за 100 г пишемо лише для факту з каси без
     коментаря: тоді сума змінилась через вагу. З коментарем причина може
     бути іншою — заміна позиції, — і пояснює її оператор. */
  const text = a.kind === 'ship'
    ? `🚕 Замовлення № ${o.no}: доставка ${money(a.amount)}${a.note ? ` — ${a.note}` : ''}.
До сплати: ${money(o.total)}`
    : a.kind === 'note'
    ? `💬 Замовлення № ${o.no}. Оператор: ${a.note}`
    : a.kind === 'fact'
      ? `🧾 Замовлення № ${o.no} зважили: до сплати ${money(o.total)} (було ${money(a.from)}).\n` +
        (a.note ? `Оператор: ${a.note}` : `Ціна за 100 г не змінилась — змінилась лише вага.`)
      : `${a.kind === 'add' ? '➕' : '➖'} Замовлення № ${o.no}: ${a.kind === 'add' ? '+' : '−'}${money(a.amount)}` +
        ` — ${a.note || 'уточнили після зважування'}.\nДо сплати: ${money(o.total)}`;
  bot.sendMessage(u.tgId, text,
    { reply_markup: { inline_keyboard: [[{ text: 'Стежити за замовленням', url: SITE + '?order=' + o.no }]] } }
  ).catch(e => console.warn('Зміна № ' + o.no + ' не дійшла до клієнта:', e.message));
}

/* ---------- сповіщення клієнту ----------
   Хто увійшов на сайті — той уже писав нашому боту, і ми знаємо його
   чат. Тоді пишемо туди: це безкоштовно, доходить одразу і не губиться
   серед реклами, як SMS. Решті лишається SMS, поки що лише в лозі.    */
const SITE = (process.env.SITE_URL || 'https://meat-baron.kh.ua/').replace(/\/+$/, '/');

const NOTE = {
  accepted: o => `✅ Замовлення № ${o.no} прийнято.\n` +
    (o.when ? `Орієнтовно: ${o.when}\n` : '') +
    (o.mode === 'pickup' ? `Точка: ${o.shopName}` : 'Доставка: курʼєр звʼяжеться щодо вартості.'),
  onway: o => `🚗 Замовлення № ${o.no} уже в дорозі.` +
    (o.addr ? `\nВезуть за адресою: ${o.addr}` : '') +
    `\nКурʼєр зателефонує, коли буде на місці.`,
  ready: o => `🔥 Замовлення № ${o.no} готове.\n` +
    (o.mode === 'pickup' ? `Чекаємо на вас: ${o.shopName}` : 'Курʼєр уже виїжджає.')
};

function notify(o, st) {
  const make = NOTE[st];
  if (!make) return;
  /* Оператор може клацати кнопки туди-сюди — двічі про одне не пишемо. */
  o.sent = o.sent || {};
  if (o.sent[st]) return;
  o.sent[st] = true;
  save();

  const u = db.users[o.telKey] || {};
  if (!u.tgId) return sendSms(o, st);

  /* Доставлене підтверджує сам клієнт: оператор бачить лише передачу
     курʼєру (власник, 19.09). Кнопка — просто в сповіщенні. */
  const kb = [[{ text: 'Стежити за замовленням', url: SITE + '?order=' + o.no }]];
  if (st === 'onway') kb.unshift([{ text: '✅ Отримав замовлення', callback_data: `r:${o.no}` }]);

  bot.sendMessage(u.tgId, make(o), {
    reply_markup: { inline_keyboard: kb }
  }).catch(e => {
    /* Бота заблокували або чат видалено — не наша біда, але знати варто. */
    console.warn('Сповіщення № ' + o.no + ' не дійшло:', e.message);
    sendSms(o, st);
  });
}

/* ---------- SMS ----------
   Для тих, хто не входив через Telegram. Підключення до TurboSMS
   робиться тут; поки лише лог — щоб було видно, коли має піти SMS.   */
function sendSms(o, st) {
  if (st !== 'ready') return;              // SMS-ками про кожен крок не сиплемо
  const text = o.mode === 'pickup'
    ? `Мясний Барон: замовлення №${o.no} готове. Чекаємо за адресою ${o.shopName}.`
    : `Мясний Барон: замовлення №${o.no} готове, курєр виїжджає.`;
  console.log('[SMS →', telLog(o.tel) + ']', text);
  // TODO: fetch('https://api.turbosms.ua/message/send.json', {...})
}

/* Коли з чату здається, що бот «не бачить» нової команди, перше
   питання — чи Railway уже підняв новий код. Раніше перевірити це було
   нічим, і ми гадали (23.09). Тепер сервер каже, з якого коміту
   запущений і скільки працює. */
const BUILD = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
const STARTED = Date.now();

/* Живий чи ні — і більше нічого. Раніше звідси було видно, скільки в
   нас замовлень, покупців і які точки підключені: стороннім ця
   статистика ні до чого (власник питав про захист 23.09). Повна
   картина тепер у боті командою /status, номер збірки лишаємо —
   він потрібен, щоб перевіряти, чи доїхав викат. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, build: BUILD || 'невідомо' });
});

app.listen(PORT, () => console.log('Сервер працює на порту', PORT));
