/* Справжній server.js із підставним Telegram-ботом і тимчасовою базою.
   Бот записує все, що «надіслав», і дає «натискати» команди, кнопки й
   «ділитися номером» так, як це робили б оператор і покупець. Кожен
   тестовий файл vitest живе в окремому процесі, тож свій сервер на
   своєму порту. В інтернет нічого не шле. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

module.exports = async ({ port, env = {} }) => {
  const sent = [];          // { chatId, text, kb } — усе, що бот надіслав
  const edits = [];         // { chatId, text } — оновлені картки в чаті
  const handlers = [];
  const on = { message: [], callback_query: [], contact: [] };
  let msgId = 100;

  class FakeBot {
    onText(re, fn) { handlers.push([re, fn]) }
    on(ev, fn) { (on[ev] || (on[ev] = [])).push(fn) }
    async sendMessage(chatId, text, opt = {}) {
      const kb = (opt.reply_markup && opt.reply_markup.inline_keyboard) || [];
      sent.push({ chatId, text, kb: kb.flat() });
      return { message_id: ++msgId, chat: { id: chatId } };
    }
    async editMessageText(text, opt = {}) { edits.push({ chatId: opt.chat_id, text }); return true }
    async editMessageReplyMarkup() { return true }
    async answerCallbackQuery() { return true }
    async deleteMessage() { return true }
    async sendDocument() { return true }
    async getMe() { return { username: 'test_bot' } }
    async setMyCommands() { return true }
    stopPolling() {}
  }
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'node-telegram-bot-api') return FakeBot;
    if (req === 'web-push') return { setVapidDetails() {}, generateVAPIDKeys: () => ({ publicKey: 'p', privateKey: 'k' }), sendNotification: async () => ({}) };
    return origLoad.call(this, req, ...rest);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-api-'));
  Object.assign(process.env, { BOT_TOKEN: 'x', PORT: String(port), DATA_DIR: tmp, OWNER_ID: '777', CHAT_1: '-100',
    TURBOSMS_TOKEN: '', TURBOSMS_SENDER: '', ...env });
  console.log = () => {}; console.warn = () => {};
  require(path.join(__dirname, '..', '..', 'server.js'));
  await new Promise(r => setTimeout(r, 300));

  const API = 'http://127.0.0.1:' + port;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    let d = {}; try { d = await r.json() } catch (e) {}
    return { status: r.status, d };
  };
  /* команда текстом */
  const say = (chatId, fromId, text, type = 'private') => {
    const msg = { chat: { id: chatId, type }, from: { id: fromId }, text };
    for (const [re, fn] of handlers) { const m = text.match(re); if (m) fn(msg, m) }
  };
  /* відповідь на повідомлення бота (force_reply): Telegram віддає його текст уже без розмітки */
  const reply = async (chatId, to, text) => {
    const msg = { chat: { id: chatId, type: 'group' }, from: { id: 5, first_name: 'Оля' }, text,
      reply_to_message: { message_id: 1, text: to.text.replace(/<[^>]+>/g, ''), from: { is_bot: true } } };
    for (const fn of on.message) await fn(msg);
  };
  /* натиснути кнопку під повідомленням */
  const press = async (chatId, fromId, data) => {
    const cq = { id: 'cq' + (++msgId), data, from: { id: fromId }, message: { chat: { id: chatId }, message_id: msgId } };
    for (const fn of on.callback_query) await fn(cq);
  };
  /* «📱 Поділитися номером» */
  const contact = (chatId, userId, phone, first_name = 'Тест') => {
    const msg = { chat: { id: chatId, type: 'private' }, from: { id: userId, first_name },
      contact: { user_id: userId, phone_number: phone, first_name } };
    for (const fn of on.contact) fn(msg);
  };
  const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {} };
  return { call, say, reply, press, contact, tick, sent, edits, cleanup };
};
