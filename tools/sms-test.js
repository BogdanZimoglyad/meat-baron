/* Перевірка відправки SMS на справжньому коді: вирізаємо smsSend із
   server.js і підставляємо fetch. Нікуди не дзвонимо й не шлемо.
   Запуск: node tools/sms-test.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const m = src.match(/async function smsSend\(tel, text, why\) \{[\s\S]*?\n\}/);
if (!m) { console.error('smsSend не знайдено'); process.exit(1) }

const mk = ({ on = true, reply = { response_result: [{ response_code: 0, message_id: 'abc' }] }, status = 200, boom = null }) => {
  const calls = [], logs = [], warns = [], toOwner = [];
  const env = {
    SMS_ON: on,
    SMS_URL: 'https://api.turbosms.ua/message/send.json',
    TURBOSMS_TOKEN: 'tok', TURBOSMS_SENDER: 'MeatBaron',
    OWNER_ID: 777,
    telLog: t => String(t).replace(/^(\+380\d{2})\d{3}(\d{2})(\d{2})$/, '$1***$2$3'),
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => warns.push(a.join(' ')) },
    bot: { sendMessage: (id, t) => { toOwner.push(t); return Promise.resolve() } },
    fetch: async (url, opt) => {
      calls.push({ url, opt });
      if (boom) throw Object.assign(new Error(boom), { name: boom === 'timeout' ? 'AbortError' : 'Error' });
      return { status, json: async () => reply };
    },
    AbortController, setTimeout, clearTimeout
  };
  const fn = new Function(...Object.keys(env), `${m[0]}; return smsSend`);
  return { send: fn(...Object.values(env)), calls, logs, warns, toOwner };
};

(async () => {
  const t = [];

  // 1. нормальна відправка
  let e = mk({});
  let ok = await e.send('+380661234567', 'Готове', '№1');
  const body = JSON.parse(e.calls[0].opt.body);
  t.push(['відправка вдалась', ok === true]);
  t.push(['номер без плюса й дужок', body.recipients[0] === '380661234567']);
  t.push(['відправник із змінної', body.sms.sender === 'MeatBaron']);
  t.push(['токен у заголовку', e.calls[0].opt.headers.Authorization === 'Bearer tok']);
  t.push(['у лозі номер під маскою', e.logs.join(' ').includes('+38066***4567')]);
  t.push(['повного номера в лозі немає', !e.logs.join(' ').includes('380661234567')]);

  // 2. без ключів — лише лог
  e = mk({ on: false });
  ok = await e.send('+380661234567', 'Готове');
  t.push(['без ключів нікуди не йдемо', e.calls.length === 0]);
  t.push(['без ключів пишемо в лог', e.logs.join(' ').includes('[SMS')]);

  // 3. кривий номер
  e = mk({});
  await e.send('12345', 'Готове');
  t.push(['кривий номер не шлемо', e.calls.length === 0 && e.warns.length === 1]);

  // 4. скінчились гроші
  e = mk({ reply: { response_code: 203, response_status: 'ERROR', response_result: [{ response_code: 203 }] } });
  ok = await e.send('+380661234567', 'Готове');
  t.push(['порожній рахунок — не вдалось', ok === false]);
  t.push(['про порожній рахунок кажемо власнику', e.toOwner.length === 1]);

  // 5. чужа помилка
  e = mk({ reply: { response_result: [{ response_code: 305, response_status: 'INVALID' }] } });
  ok = await e.send('+380661234567', 'Готове');
  t.push(['невірний номер — не вдалось, власника не смикаємо', ok === false && e.toOwner.length === 0]);

  // 6. мережа впала
  e = mk({ boom: 'timeout' });
  ok = await e.send('+380661234567', 'Готове');
  t.push(['таймаут не валить сервер', ok === false && e.warns.join(' ').includes('таймаут')]);

  let bad = 0;
  for (const [name, good] of t) { console.log((good ? '  ok  ' : 'ПАДАЄ') + ' · ' + name); if (!good) bad++ }
  console.log(bad ? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
  process.exit(bad ? 1 : 0);
})();
