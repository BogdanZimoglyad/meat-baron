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
const { FRY_RATE, MIN_G, kop, lineSum, fryableG, canFry } = CATALOG;
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
let db = { orders: {}, shops: {}, counter: 1000, users: {}, tokens: {} };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
/* Стара база нічого не знала про покупців: дописуємо теки, щоб код
   нижче не перевіряв їхню наявність на кожному рядку. */
db.users = db.users || {};
db.tokens = db.tokens || {};

const writeNow = () => { try { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); } catch (e) {} };

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

const STATUSES = ['new', 'accepted', 'cooking', 'ready', 'done'];
const LABEL = {
  new: 'Нове',
  accepted: 'Прийнято',
  cooking: 'Готується',
  ready: 'Готове',
  done: 'Видано'
};
const NEXT_BTN = {
  new: [['accepted', '✅ Прийняти в роботу']],
  accepted: [['cooking', '🔥 Готується']],
  cooking: [['ready', '📦 Готове']],
  ready: [['done', '🤝 Видано']],
  done: []
};

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
const wLabel = g => (g >= 1000 ? (g / 1000).toFixed(g % 1000 ? 1 : 0) + ' кг' : g + ' г');

/* ---------- вхід покупця через Telegram ----------
   Номер не питаємо текстом і нікуди не надсилаємо код. Сайт відкриває
   бота з разовим ключем, людина тисне «Поділитися номером», і номер
   приходить від самого Telegram. Введений руками номер нічого не
   доводить: за ним можна було б забрати чужу історію замовлень.  */
const AUTH_TTL = 5 * 60 * 1000;        // скільки живе спроба входу
const logins = new Map();              // ключ входу → стан спроби
const chatLogin = new Map();           // чат у Telegram → ключ входу

let BOT_NAME = process.env.BOT_USERNAME || '';
bot.getMe()
  .then(me => { BOT_NAME = me.username || BOT_NAME; console.log('Бот @' + BOT_NAME); })
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

bot.onText(/\/bind\s+(\d+)(?:\s+(\S+))?/, (msg, m) => {
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

/* ---------- текст замовлення ---------- */
function orderText(o) {
  const lines = o.lines.map(l => {
    const qty = l.unit === 'шт' ? l.g + ' шт'
              : l.unit === 'пак' ? l.g + ' × 1 кг'
              : wLabel(l.g);
    /* Вогник біля позиції — щоб оператор бачив, що саме на мангал.
       Смаження тепер обирають на кожній позиції окремо, і одного
       підсумку внизу вже не досить. */
    return `• ${esc(l.name)} — ${qty} — ${money(l.sum)}${l.fry ? ' 🔥' : ''}`;
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

  return `<b>Замовлення № ${o.no}</b> — ${LABEL[o.status]}\n` +
    `${delivery}${when}\n${pay}\n\n${lines}${fry}\n\n` +
    `<b>Разом: ${money(o.total)}</b>${warn}\n` +
    `<i>Сума орієнтовна — залежить від фактичної ваги</i>\n\n` +
    `👤 ${esc(o.nm)}\n📞 ${esc(o.tel)}` +
    (o.note ? `\n\n💬 <b>Коментар:</b> ${esc(o.note)}` : '');
}

function keyboard(o) {
  const btns = NEXT_BTN[o.status].map(([st, txt]) => ([{ text: txt, callback_data: `s:${o.no}:${st}` }]));
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
const RATE = { order: 5, status: 150, history: 20, auth: 10, poll: 120 };

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
    lines.push({
      name: it.name, grp: it.grp, cat: it.cat, unit: it.unit, id: it.id,
      g: q, sum: lineSum({ unit: it.unit, price: it.price, g: q }),
      fry: canFry(it) && (perLine ? !!raw.fry : !!b.fry)
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
  res.json({ no: o.no, status: o.status, label: LABEL[o.status], total: o.total, mode: o.mode });
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
function historyOf(telKey) {
  const MAX_AGE = 60 * 24 * 3600 * 1000;   // 60 днів
  return Object.values(db.orders)
    .filter(o => (o.telKey || normTel(o.tel)) === telKey)
    .filter(o => Date.now() - (o.createdAt || 0) < MAX_AGE)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(o => ({
      no: o.no,
      status: o.status,
      label: LABEL[o.status],
      createdAt: o.createdAt,
      shopName: o.shopName,
      mode: o.mode,
      fry: o.fry,
      total: o.total,
      lines: Array.isArray(o.lines) ? o.lines : []
    }));
}

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

  o.status = st;
  o.updatedAt = Date.now();
  save();

  await bot.editMessageText(orderText(o), {
    chat_id: o.chatId,
    message_id: o.msgId,
    parse_mode: 'HTML',
    reply_markup: keyboard(o)
  }).catch(e => console.error('edit:', e.message));

  await bot.answerCallbackQuery(cq.id, { text: LABEL[st] });

  // SMS клієнту, коли замовлення готове
  if (st === 'ready') sendSms(o);
});

/* ---------- SMS ----------
   Підключення до TurboSMS / SMSClub робиться тут.
   Поки що лише лог — щоб було видно, коли має піти повідомлення.        */
function sendSms(o) {
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
