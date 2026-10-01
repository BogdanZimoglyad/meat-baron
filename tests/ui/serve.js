/* Сервер для тестів у браузері: справжній server.js із підставним ботом
   (tests/api/harness.js) і тимчасовою базою. Сайт, панель і статистику
   віддає він сам — ті самі файли, що й GitHub Pages.
   Поруч, на порту +1, — «пульт» за Telegram: тест через нього пише
   команди в чат точки, тисне кнопки, ділиться номером і читає, що бот
   надіслав. Запускає Playwright сам (playwright.config.mjs). */
const http = require('http');

const PORT = Number(process.env.UI_PORT || 38790);

(async () => {
  const h = await require('../api/harness.js')({ port: PORT });
  const routes = {
    'GET /sent': () => h.sent,
    'POST /clear': () => { h.sent.length = 0; return { ok: true } },
    'POST /say': b => { h.say(b.chatId, b.fromId, b.text, b.type); return { ok: true } },
    'POST /press': async b => { await h.press(b.chatId, b.fromId, b.data); return { ok: true } },
    'POST /contact': b => { h.contact(b.chatId, b.userId, b.phone, b.name); return { ok: true } }
  };
  http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      const fn = routes[req.method + ' ' + req.url];
      if (!fn) { res.writeHead(404); return res.end() }
      try {
        const out = await fn(raw ? JSON.parse(raw) : {});
        await h.tick(30);              // боту дати відповісти
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(String(e.stack || e)) }
    });
  }).listen(PORT + 1, '127.0.0.1');
  process.stderr.write(`ui-serve: сайт ${PORT}, пульт ${PORT + 1}\n`);
})();
