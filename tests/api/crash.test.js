/* Відмова Telegram не валить сервер (аудит 02.10): раніше будь-яка
   помилка бота без .catch зупиняла весь процес, і сайт не приймав
   замовлень. Ганяємо в окремому процесі — vitest сам ловить такі
   помилки у своєму й не дав би побачити, що з ними робить server.js. */
const path = require('path');
const { spawnSync } = require('child_process');

const harness = path.join(__dirname, 'harness.js').replace(/\\/g, '/');
const script = `
  (async () => {
    const { call, cleanup } = await require('${harness}')({ port: 38799 });
    /* так виглядає відмова бота: обіцянка відхилена, і ніхто її не ловить */
    Promise.reject(new Error('ETELEGRAM: 400 Bad Request: query is too old'));
    await new Promise(r => setTimeout(r, 200));
    const r = await call('GET', '/api/health');
    cleanup();
    process.stdout.write(r.status === 200 ? 'ЖИВИЙ' : 'ВІДПОВІДЬ ' + r.status);
    process.exit(0);
  })();`;

test('відмова Telegram не зупиняє сервер — сайт і далі відповідає', () => {
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  expect(r.stdout, r.stderr).toContain('ЖИВИЙ');
  expect(r.status).toBe(0);
});
