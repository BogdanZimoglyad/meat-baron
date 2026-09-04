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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- зберігання ---------- */
const DB = path.join(__dirname, 'data.json');
let db = { orders: {}, shops: {}, counter: 1000 };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));

/* ---------- точки ---------- */
const SHOPS = [
  'Пр-т Героїв Харкова 256',
  'вул. Людвіга Свободи 50',
  'пр-т Тракторобудівників 142а',
  'вул. Шевченка 142а',
  'м-н Захисників України 7/8',
  'вул. Різдвяна 16/22',
  'пр-т Аерокосмічний 316е',
  'вул. Холодногірська 3'
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

const money = n => (Math.round(n * 100) / 100).toFixed(2).replace('.00', '') + ' ₴';
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
  bot.sendMessage(msg.chat.id, `Готово. Цей чат отримує замовлення точки:\n${SHOPS[n - 1]}`);
});

bot.onText(/\/whoami/, msg => {
  const i = Object.keys(db.shops).find(k => db.shops[k] === msg.chat.id);
  bot.sendMessage(msg.chat.id, i !== undefined
    ? `Точка: ${SHOPS[i]}\nID чату: ${msg.chat.id}`
    : `Чат ще не прив’язаний. ID: ${msg.chat.id}\nВикористайте /bind НОМЕР`);
});

/* ---------- текст замовлення ---------- */
function orderText(o) {
  const lines = o.lines.map(l =>
    `• ${l.name} — ${l.unit === 'порція' ? l.g + ' шт' : wLabel(l.g)} — ${money(l.sum)}`
  ).join('\n');

  const fry = o.fry
    ? `\n🔥 СМАЖИТИ: ${wLabel(o.fg)} — ${money(o.fg / 1000 * 50)}\n   (ужарка 30–35%)`
    : '';

  const delivery = o.mode === 'delivery'
    ? `\n🚚 ДОСТАВКА: ${o.addr || '—'}\n   ⚠️ передзвонити, уточнити вартість доставки`
    : `\n🏪 САМОВИВІЗ: ${o.shopName}`;

  const pay = { online: '💳 Оплачено онлайн', cash: '💵 Готівкою', card: '💳 Карткою на місці' }[o.pay] || o.pay;

  return `<b>Замовлення № ${o.no}</b> — ${LABEL[o.status]}\n` +
    `${delivery}\n${pay}\n\n${lines}${fry}\n\n` +
    `<b>Разом: ${money(o.total)}</b>\n` +
    `<i>Сума орієнтовна — залежить від фактичної ваги</i>\n\n` +
    `👤 ${o.nm}\n📞 ${o.tel}`;
}

function keyboard(o) {
  const btns = NEXT_BTN[o.status].map(([st, txt]) => ([{ text: txt, callback_data: `s:${o.no}:${st}` }]));
  if (o.status !== 'done') btns.push([{ text: '📞 Подзвонити клієнту', url: `tel:${o.tel.replace(/\s/g, '')}` }]);
  return { inline_keyboard: btns };
}

/* ---------- приймання замовлення з сайту ---------- */
app.post('/api/order', async (req, res) => {
  const b = req.body || {};
  if (!b.nm || !b.tel || !Array.isArray(b.lines) || !b.lines.length) {
    return res.status(400).json({ error: 'Некоректні дані замовлення' });
  }

  const shopIndex = Number.isInteger(b.shop) ? b.shop : 0;
  const chatId = db.shops[shopIndex];
  if (!chatId) {
    return res.status(503).json({ error: 'Точка ще не підключена до Telegram' });
  }

  const no = ++db.counter;
  const o = {
    no,
    status: 'new',
    shop: shopIndex,
    shopName: SHOPS[shopIndex],
    mode: b.mode === 'delivery' ? 'delivery' : 'pickup',
    addr: b.addr || '',
    fry: !!b.fry,
    fg: b.fg || 0,
    pay: b.pay || 'cash',
    nm: b.nm,
    tel: b.tel,
    lines: b.lines,
    total: b.total,
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
    console.error('Telegram error:', e.message);
    res.status(500).json({ error: 'Не вдалося передати замовлення на точку' });
  }
});

/* ---------- статус для сайту ---------- */
app.get('/api/order/:no', (req, res) => {
  const o = db.orders[req.params.no];
  if (!o) return res.status(404).json({ error: 'Замовлення не знайдено' });
  res.json({ no: o.no, status: o.status, label: LABEL[o.status], total: o.total, mode: o.mode });
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

app.listen(PORT, () => console.log('Сервер працює на порту', PORT));
