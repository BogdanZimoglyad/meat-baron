/* Спільне для тестів у браузері.
   page — сторінки ходять у локальний server.js замість
   api.meat-baron.kh.ua (адресу підміняємо просто в HTML при віддачі), а
   все стороннє (шрифти, карти) відрізане: тест не залежить від
   інтернету і нікуди не пише.
   bot — пульт за Telegram (див. serve.js). */
const { test: base, expect } = require('@playwright/test');

const PORT = Number(process.env.UI_PORT || 38790);
const SITE = `http://127.0.0.1:${PORT}`;
const PULT = `http://127.0.0.1:${PORT + 1}`;
const CHAT = -100;          // чат точки (CHAT_1 у harness.js)
const OWNER = 777;          // OWNER_ID у harness.js

const test = base.extend({
  /* Кожен тест — «інший покупець» зі своєю адресою: сервер приймає не
     більше 5 замовлень з однієї адреси за кілька хвилин (захист), і без
     цього тести впирались би в нього. Адресу сервер бере з
     X-Forwarded-For — так само, як за проксі Railway. */
  extraHTTPHeaders: async ({}, use) => {
    const n = () => 1 + Math.floor(Math.random() * 250);
    await use({ 'X-Forwarded-For': `10.${n()}.${n()}.${n()}` });
  },
  page: async ({ page }, use) => {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') return route.abort();
      const isPage = route.request().resourceType() === 'document';
      if (!isPage) return route.continue();
      const resp = await route.fetch();
      const body = (await resp.text()).replace(/const API='https:\/\/api\.meat-baron\.kh\.ua'/g, 'const API=location.origin');
      return route.fulfill({ response: resp, body });
    });
    await use(page);
  },
  bot: async ({ request }, use) => {
    const post = async (p, data) => (await request.post(PULT + p, { data })).json();
    await use({
      sent: async () => (await request.get(PULT + '/sent')).json(),
      clear: () => post('/clear'),
      say: (chatId, fromId, text, type = 'group') => post('/say', { chatId, fromId, text, type }),
      press: (chatId, fromId, data) => post('/press', { chatId, fromId, data }),
      contact: (chatId, userId, phone, name) => post('/contact', { chatId, userId, phone, name }),
      /* разове посилання з чату: /panel у чаті точки, /stats у власника */
      link: async (cmd, chatId, fromId, type) => {
        await post('/clear');
        await post('/say', { chatId, fromId, text: cmd, type });
        const m = (await (await request.get(PULT + '/sent')).json())
          .map(x => x.text).join('\n').match(/(op|stats)\.html#([0-9a-f]+)/);
        return m && `${SITE}/${m[1]}.html#${m[2]}`;
      }
    });
  }
});

module.exports = { test, expect, SITE, CHAT, OWNER };
