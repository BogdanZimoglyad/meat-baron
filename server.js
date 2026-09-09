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
 *   PORT       — порт (за замовчуванням 3000)
 */

const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

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
  'readme.md', 'data', 'node_modules'
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
let db = { orders: {}, shops: {}, counter: 1000 };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
const save = () => { try { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); } catch (e) {} };

/* Прив'язки чатів беремо зі змінних оточення CHAT_1, CHAT_2, …
   Диск на хостингу очищується при кожному перезапуску, а змінні — ні.
   Тому після /bind збережіть виданий ID у змінних проєкту. */
for (let i = 1; i <= 20; i++) {
  const v = process.env['CHAT_' + i];
  if (v) db.shops[i - 1] = Number(v);
}

/* ---------- точки ---------- */
/* На час тесту працюють дві точки.
   Щоб підключити решту — розкоментуй потрібні рядки
   і перепривʼяжи чати командою /bind. */
const SHOPS = [
  'пр-т Людвіга Свободи 52',
  'вул. Шевченка 142а'
  // 'Пр-т Героїв Харкова 256',
  // 'пр-т Тракторобудівників 142а',
  // 'м-н Захисників України 7/8',
  // 'вул. Різдвяна 16/22',
  // 'пр-т Аерокосмічний 316е',
  // 'вул. Холодногірська 3'
];

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

const FRY_RATE = 50;                              // ₴ за кг смаження
const kop = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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

/* ---------- прив'язка чату до точки ---------- */
bot.onText(/\/start|\/help/, msg => {
  bot.sendMessage(msg.chat.id,
    'Бот прийому замовлень «Мʼясний Барон».\n\n' +
    'Щоб цей чат отримував замовлення певної точки, надішліть:\n' +
    '/bind НОМЕР\n\n' +
    'Список точок — /points\n' +
    'Поточна прив’язка — /whoami');
});

bot.onText(/\/points/, msg => {
  bot.sendMessage(msg.chat.id,
    'Точки:\n' + SHOPS.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    '\n\nПрив’язати: /bind 1');
});

bot.onText(/\/bind (\d+)/, (msg, m) => {
  const n = parseInt(m[1], 10);
  if (n < 1 || n > SHOPS.length) return bot.sendMessage(msg.chat.id, 'Немає такої точки. /points');
  db.shops[n - 1] = msg.chat.id;
  save();
  bot.sendMessage(msg.chat.id,
    `Готово. Цей чат отримує замовлення точки:\n${SHOPS[n - 1]}\n\n` +
    `Щоб прив'язка не злетіла після перезапуску сервера, додайте у змінні проєкту:\n` +
    `<code>CHAT_${n} = ${msg.chat.id}</code>`,
    { parse_mode: 'HTML' });
});

bot.onText(/\/whoami/, msg => {
  const i = Object.keys(db.shops).find(k => db.shops[k] === msg.chat.id);
  bot.sendMessage(msg.chat.id, i !== undefined
    ? `Точка: ${SHOPS[i]}\nID чату: ${msg.chat.id}`
    : `Чат ще не прив’язаний. ID: ${msg.chat.id}\nВикористайте /bind НОМЕР`);
});

/* ---------- текст замовлення ---------- */
function orderText(o) {
  const lines = o.lines.map(l => {
    const qty = l.unit === 'шт' ? l.g + ' шт'
              : l.unit === 'пак' ? l.g + ' × 1 кг'
              : wLabel(l.g);
    return `• ${esc(l.name)} — ${qty} — ${money(l.sum)}`;
  }).join('\n');

  const fry = o.fry
    ? `\n🔥 СМАЖИТИ: ${wLabel(o.fg)} — ${money(o.fg / 1000 * FRY_RATE)}\n   (ужарка 30–35%)`
    : '';

  const delivery = o.mode === 'delivery'
    ? `\n🚚 ДОСТАВКА: ${esc(o.addr) || '—'}\n   ⚠️ передзвонити, уточнити вартість доставки`
    : `\n🏪 САМОВИВІЗ: ${esc(o.shopName)}`;

  const pay = { online: '💳 Оплачено онлайн', cash: '💵 Готівкою', card: '💳 Карткою на місці' }[o.pay] || o.pay;
  const when = o.when ? `\n🕒 <b>${esc(o.when)}</b>` : '';

  return `<b>Замовлення № ${o.no}</b> — ${LABEL[o.status]}\n` +
    `${delivery}${when}\n${pay}\n\n${lines}${fry}\n\n` +
    `<b>Разом: ${money(o.total)}</b>\n` +
    `<i>Сума орієнтовна — залежить від фактичної ваги</i>\n\n` +
    `👤 ${esc(o.nm)}\n📞 ${esc(o.tel)}` +
    (o.note ? `\n\n💬 <b>Коментар:</b> ${esc(o.note)}` : '');
}

function keyboard(o) {
  const btns = NEXT_BTN[o.status].map(([st, txt]) => ([{ text: txt, callback_data: `s:${o.no}:${st}` }]));
  return { inline_keyboard: btns };
}

/* ---------- захист від напливу замовлень ---------- */
const hits = new Map();                       // ip → [часи запитів]
const RATE_WINDOW = 10 * 60 * 1000;           // вікно 10 хвилин
const RATE_MAX = 5;                           // не більше 5 замовлень з однієї адреси
function tooOften(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();         // щоб не росло безмежно
  return list.length > RATE_MAX;
}

/* ---------- приймання замовлення з сайту ---------- */
app.post('/api/order', async (req, res) => {
  const b = req.body || {};

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
           || req.socket.remoteAddress || 'unknown';
  if (tooOften(ip)) {
    return res.status(429).json({ error: 'Забагато замовлень поспіль. Зачекайте кілька хвилин.' });
  }

  const nm = String(b.nm || '').trim().slice(0, 60);
  const telKey = normTel(b.tel);
  if (nm.length < 2 || telKey.length !== 9) {
    return res.status(400).json({ error: 'Вкажіть імʼя та коректний номер телефону' });
  }
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 40) {
    return res.status(400).json({ error: 'Некоректний склад замовлення' });
  }
  const total = Number(b.total);
  if (!Number.isFinite(total) || total <= 0 || total > 200000) {
    return res.status(400).json({ error: 'Некоректна сума замовлення' });
  }
  // чистимо позиції від зайвого
  const lines = b.lines.slice(0, 40).map(l => ({
    name: String(l.name || '').slice(0, 80),
    unit: ['шт', 'пак', 'вага'].includes(l.unit) ? l.unit : 'вага',
    g: Math.max(0, Math.min(Number(l.g) || 0, 20000)),
    id: String(l.id || '').slice(0, 12),
    grp: String(l.grp || '').slice(0, 40),
    sum: Math.max(0, Number(l.sum) || 0)
  }));

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
      hint: `Надішліть боту /bind ${shopIndex + 1} у потрібному чаті`
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
    fry: !!b.fry,
    fg: Math.max(0, Math.min(Number(b.fg) || 0, 40000)),
    pay: ['online','cash','card'].includes(b.pay) ? b.pay : 'cash',
    nm,
    tel: '+380' + telKey,
    telKey,
    note: String(b.note || '').slice(0, 400),
    when: String(b.when || '').slice(0, 80),
    lines,
    total,
    createdAt: Date.now()
  };
  db.orders[no] = o;
  save();

  try {
    const sent = await bot.sendMessage(chatId, orderText(o), {
      parse_mode: 'HTML',
      reply_markup: keyboard(o)
    });
    o.msgId = sent.message_id;
    o.chatId = chatId;
    save();
    res.json({ ok: true, no, status: o.status });
  } catch (e) {
    const detail = (e.response && e.response.body && e.response.body.description) || e.message;
    console.error('Telegram error:', detail);
    res.status(500).json({ error: 'Не вдалося передати замовлення на точку', detail });
  }
});

/* ---------- статус для сайту ---------- */
app.get('/api/order/:no', (req, res) => {
  const o = db.orders[req.params.no];
  if (!o) return res.status(404).json({ error: 'Замовлення не знайдено' });
  res.json({ no: o.no, status: o.status, label: LABEL[o.status], total: o.total, mode: o.mode });
});

/* ---------- історія замовлень за номером ---------- */
app.get('/api/history/:tel', (req, res) => {
  const key = normTel(req.params.tel);
  if (key.length < 9) return res.status(400).json({ error: 'Некоректний номер' });

  /* Навмисно не віддаємо імʼя та адресу — щоб за чужим номером
     не можна було дізнатися особисті дані. Лише склад для повтору. */
  const MAX_AGE = 60 * 24 * 3600 * 1000;   // 60 днів
  const list = Object.values(db.orders)
    .filter(o => (o.telKey || normTel(o.tel)) === key)
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
    storage: process.env.DATA_DIR ? 'постійне (' + process.env.DATA_DIR + ')' : 'тимчасове — дані зникнуть при перезапуску'
  });
});

app.listen(PORT, () => console.log('Сервер працює на порту', PORT));
