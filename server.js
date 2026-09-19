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
const { FRY_RATE, MIN_G, kop, lineSum, fryableG, canFry, countUnitOf, variantsOf, priceOf, lineTitle, packLabel, portionOf } = CATALOG;
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
let db = { orders: {}, shops: {}, counter: 1000, users: {}, tokens: {}, busy: {}, extra: {}, daySent: {} };
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

  console.log('Вхід покупця:', u.tel);
  bot.sendMessage(msg.chat.id,
    `Готово, ${u.name || 'вітаємо'}. Поверніться на сайт — ви вже увійшли.`,
    { reply_markup: { remove_keyboard: true } });
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
bot.on('callback_query', async cq => {
  const [tag, iStr, val, arg] = (cq.data || '').split(':');
  if (tag !== 'g') return;
  const i = Number(iStr), chatId = cq.message && cq.message.chat.id;
  /* Тільки зі свого чату: чужа точка не має чіпати мангал сусідам */
  if (db.shops[i] !== chatId) return bot.answerCallbackQuery(cq.id, { text: 'Це інша точка' });
  db.busy = db.busy || {};
  db.extra = db.extra || {};
  let note;
  if (val === 'add') {
    const slot = hourFloor(Number(arg) || 0);
    if (!slot || slot < hourFloor(Date.now())) {
      return bot.answerCallbackQuery(cq.id, { text: 'Ця година вже минула — відкрийте /mangal ще раз' });
    }
    const e = db.extra[i] || (db.extra[i] = {});
    e[slot] = (e[slot] || 0) + ADD_STEP_G;
    /* Надбавка означає «беремо ще», тож знімаємо і загальне блокування */
    if (db.busy[i] && slot < db.busy[i]) db.busy[i] = slot;
    note = `+${wLabel(ADD_STEP_G)} на ${hhmm(slot)}`;
  } else if (val === 'noadd') {
    db.extra[i] = {};
    note = 'Надбавки прибрано';
  } else if (val === 'free') {
    db.busy[i] = 0;
    note = 'Мангал знову приймає';
  } else if (val === 'day') {
    db.busy[i] = Date.now() + tillCloseMs();
    note = 'Закрито до кінця дня';
  } else {
    db.busy[i] = Date.now() + (Number(val) || 60) * 60000;
    note = `Закрито до ${hhmm(db.busy[i])}`;
  }
  save();
  await bot.editMessageText(busyText(i), { chat_id: chatId, message_id: cq.message.message_id,
    parse_mode: 'HTML', reply_markup: busyKb(i) }).catch(() => {});
  bot.answerCallbackQuery(cq.id, { text: note });
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

/* ---------- підсумок дня ----------
   Скільки замовлень, кілограмів і грошей зробила точка за день. Приходить
   сам після закриття, а до того його можна спитати командою /day. */
const kyivDate = (ts = Date.now()) =>
  new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });   // 2026-09-19

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

  return `<b>Замовлення № ${o.no}</b> — ${LABEL[o.status]}\n` +
    `${delivery}${when}\n${pay}\n\n${lines}${fry}\n\n` +
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
const RATE = { order: 5, status: 300, history: 20, auth: 10, poll: 120, grill: 120 };

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

  /* Година, на яку записується мангал. Сайт рахує те саме, але
     перевіряємо тут: поки людина заповнювала форму, годину могли
     розібрати, та й запит до API можна надіслати повз сайт. */
  const slotAt = Number.isFinite(b.slotAt) && b.slotAt > Date.now() - HOUR
    ? hourFloor(b.slotAt) : 0;
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
    fry,
    fg,
    mismatch,
    /* 'online' навмисно не приймаємо: онлайн-оплати ще немає, і позначка
       «оплачено» у чаті точки означала б гроші, яких ніхто не отримував. */
    pay: ['cash','card'].includes(b.pay) ? b.pay : 'cash',
    nm,
    tel: '+380' + telKey,
    telKey,
    note: String(b.note || '').slice(0, 400),
    when: String(b.when || '').slice(0, 80),
    slotAt,
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
    console.error('Telegram error:', detail, '· замовлення не збережено:', JSON.stringify(o));
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
    if (o.mode === 'delivery' && o.addr) u.addr = o.addr;
    u.lastSeen = Date.now();
    db.users[who.telKey] = u;
  }
  save();
  countHit('order', ip);                       // зараховуємо лише те, що дійшло
  res.json({ ok: true, no, status: o.status, total: o.total });
});

/* ---------- статус для сайту ---------- */
app.get('/api/order/:no', (req, res) => {
  /* Номери йдуть підряд, тож без ліміту їх можна було б просто перебрати
     і побачити суми всіх замовлень магазину. */
  if (tooOften('status', ipOf(req), RATE.status)) {
    return res.status(429).json({ error: 'Забагато запитів. Зачекайте кілька хвилин.' });
  }
  const o = db.orders[req.params.no];
  if (!o) return res.status(404).json({ error: 'Замовлення не знайдено' });
  res.json({ no: o.no, status: o.status, label: LABEL[o.status], total: o.total, mode: o.mode,
             ...(adjustmentsOf(o).length ? { totalOrig: o.totalOrig, adjust: pubAdjust(o) } : {}) });   // зміни оператора
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
  res.json({ ok: true, status: 'ok', token: s.token, tel: u.tel || ('+380' + s.telKey), name: u.name || '', addr: u.addr || '' });
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
  res.json({ ok: true, tel: u.tel || ('+380' + a.telKey), name: u.name || '', addr: u.addr || '' });
});

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
  u.lastSeen = Date.now();
  db.users[a.telKey] = u;
  save();
  res.json({ ok: true, tel: u.tel, name: u.name || '', addr: u.addr || '' });
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
  total: o.total,
  ...(adjustmentsOf(o).length ? { totalOrig: o.totalOrig, adjust: pubAdjust(o) } : {}),
  lines: Array.isArray(o.lines) ? o.lines : []
});
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
  const o = ordersOf(a.telKey)
    .filter(o => !FINAL.has(o.status))
    .filter(o => Date.now() - (o.createdAt || 0) < DAY)[0];
  res.json({ ok: true, order: o ? pubOrder(o) : null });
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
bot.on('callback_query', async cq => {
  const [tag, noStr, st] = (cq.data || '').split(':');
  if (tag !== 's') return;

  const o = db.orders[noStr];
  if (!o) return bot.answerCallbackQuery(cq.id, { text: 'Замовлення не знайдено' });
  if (!STATUSES.includes(st)) return bot.answerCallbackQuery(cq.id, { text: 'Невідомий статус' });
  /* Лише в чаті тієї точки, куди прийшло замовлення */
  if (cq.message && cq.message.chat.id !== o.chatId) {
    return bot.answerCallbackQuery(cq.id, { text: 'Це замовлення іншої точки' });
  }
  /* Статус іде лише вперед, на один крок. Старе повідомлення чи швидкий
     подвійний дотик натискали кнопку, якої вже не мало бути, — і
     «Готове» відкочувалось назад у «Готується», у клієнта теж. */
  if (!nextBtns(o).some(([next]) => next === st)) {
    await bot.editMessageReplyMarkup(keyboard(o), { chat_id: o.chatId, message_id: o.msgId }).catch(() => {});
    return bot.answerCallbackQuery(cq.id, { text: `Уже «${LABEL[o.status]}» — кнопки оновлено` });
  }

  o.status = st;
  dropRemind(o);                  // взяли в роботу — нагадування зайве
  o.updatedAt = Date.now();
  save();

  await bot.editMessageText(orderText(o), {
    chat_id: o.chatId,
    message_id: o.msgId,
    parse_mode: 'HTML',
    reply_markup: keyboard(o)
  }).catch(e => console.error('edit:', e.message));

  await bot.answerCallbackQuery(cq.id, { text: LABEL[st] });

  notify(o, st);
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
  cancel: o => `Замовлення № ${o.no} — ${LABEL[o.status]}.\n✖️ Напишіть <b>причину скасування</b> відповіддю на це повідомлення — її побачить клієнт.\nНаприклад: немає в наявності або клієнт відмовився`,
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

  /* Скасування — не зміна суми: замовлення виходить із ланцюжка, кнопки
     зникають, а зайнята година на мангалі звільняється сама (скасовані
     grillLoad не рахує). */
  if (conf.kind === 'cancel') {
    o.adjust = adjustmentsOf(o).slice();
    o.adjust.push({ kind: 'cancel', note: conf.note, by: opName(cq.from), at: Date.now(), from: o.status });
    o.status = CANCELED;
    dropRemind(o);
    o.updatedAt = Date.now();
    save();
    await bot.editMessageText(orderText(o), {
      chat_id: o.chatId, message_id: o.msgId, parse_mode: 'HTML', reply_markup: keyboard(o)
    }).catch(e => console.error('edit:', e.message));
    await bot.editMessageText(`✖️ № ${o.no} скасовано: ${conf.note}`,
      { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
    await bot.answerCallbackQuery(cq.id, { text: 'Скасовано' });
    return notifyCancel(o, conf.note);
  }

  /* ac — застосовуємо. Суму рахуємо від поточної, а не від тієї, що була
     в момент запиту: між запитом і підтвердженням міг устигнути інший
     оператор. */
  const before = o.total;
  const next = nextTotal(before, conf.kind, conf.amount, o);
  if (conf.kind !== 'note' && conf.kind !== 'cancel' && (next <= 0 || next > MAX_TOTAL)) {
    await bot.editMessageText(`Сума замовлення № ${o.no} вийшла б ${money(next)} — так не можна.`,
      { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
    return bot.answerCallbackQuery(cq.id, { text: 'Некоректна сума' });
  }

  const prevShip = o.ship || 0;                    // попередня доставка — щоб показати «було»
  o.adjust = adjustmentsOf(o).slice();              // стара одна зміна стає першою в списку
  if (o.totalOrig == null) o.totalOrig = o.total;   // сума з сайту лишається назавжди
  o.adjust.push({ kind: conf.kind, amount: conf.amount, note: conf.note, by: opName(cq.from), at: Date.now(),
                  ...(conf.kind === 'fact' ? { from: before } : {}),   // факт — з чого перейшли
                  ...(conf.kind === 'ship' ? { from: prevShip } : {}) });
  if (conf.kind === 'ship') o.ship = conf.amount;  // тримаємо окремо: наступна доставка замінить цю
  o.total = next;
  delete o.totalNote; delete o.totalBy; delete o.totalAt;
  o.updatedAt = Date.now();
  save();

  await bot.editMessageText(orderText(o), {
    chat_id: o.chatId, message_id: o.msgId, parse_mode: 'HTML', reply_markup: keyboard(o)
  }).catch(e => console.error('edit:', e.message));
  await bot.editMessageText(
    conf.kind === 'ship' ? `✅ № ${o.no}: доставка ${money(conf.amount)}${prevShip ? ` (було ${money(prevShip)})` : ''}, разом ${money(next)}`
    : conf.kind === 'note' ? `✅ Коментар до № ${o.no} надіслано: ${conf.note}`
    : conf.kind === 'fact' ? `✅ № ${o.no}: фактична сума ${money(next)} (було ${money(before)}, ${diffText(before, next)})` + (conf.note ? `\n${conf.note}` : '')
    : `✅ № ${o.no}: ${money(before)} ${conf.kind === 'add' ? '+' : '−'} ${money(conf.amount)} = ${money(next)}` + (conf.note ? `\n${conf.note}` : ''),
    { chat_id: chatId, message_id: cq.message.message_id }).catch(() => {});
  await bot.answerCallbackQuery(cq.id, { text: 'Готово' });

  notifyAdjust(o, o.adjust[o.adjust.length - 1]);
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
  if (!u.tgId) return console.log('[SMS →', o.tel + ']', text.replace(/\n/g, ' '));
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

  bot.sendMessage(u.tgId, make(o), {
    reply_markup: { inline_keyboard: [[{ text: 'Стежити за замовленням', url: SITE + '?order=' + o.no }]] }
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
  console.log('[SMS →', o.tel + ']', text);
  // TODO: fetch('https://api.turbosms.ua/message/send.json', {...})
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    shops: SHOPS.map((name, i) => ({ i: i + 1, name, connected: !!db.shops[i] })),
    orders: Object.keys(db.orders).length,
    users: Object.keys(db.users).length,
    login: BOT_NAME ? 'через @' + BOT_NAME : 'імʼя бота ще не відоме',
    storage: process.env.DATA_DIR ? 'постійне (' + process.env.DATA_DIR + ')' : 'тимчасове — дані зникнуть при перезапуску'
  });
});

app.listen(PORT, () => console.log('Сервер працює на порту', PORT));
