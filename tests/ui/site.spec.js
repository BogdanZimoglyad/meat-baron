/* Сайт очима покупця з телефона: каталог → картка → кошик → оформлення
   → сторінка замовлення; вхід через Telegram; доставка. Замовлення йде
   у справжній server.js, бот — підставний (див. serve.js), тож тест
   бачить і те, що прийшло в чат точки. */
const { test, expect, CHAT } = require('./fixtures.js');

const CLIENT = 9100;   // Telegram-акаунт покупця на «пульті»

/* Номер вписуємо цілим, як підставляє автозаповнення телефона */
const fillContacts = async (page, nm, tel) => {
  await page.locator('#nm').fill(nm);
  await page.locator('#tel').fill(tel);
};
/* з відкритого кошика — до форми оформлення */
const checkout = async page => {
  await page.locator('#toCheckout').click();
  /* «До мʼяса» показуємо раз за візит — далі одразу оформлення */
  const next = page.locator('#upNext');
  await expect(next.or(page.locator('#send'))).toBeVisible();
  if (await next.isVisible()) await next.click();
};
const toCheckout = async page => {
  await page.locator('#barBtn').click();
  await checkout(page);
};
const orderNo = async page => Number((await page.locator('#sheet').innerText()).match(/№\s*(\d+)/)[1]);

test('гість: кошик → оформлення → картка в чаті точки → сторінка бачить «Прийнято»', async ({ page, bot }) => {
  test.setTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');

  /* картка товару: вага кнопкою */
  await page.getByRole('button', { name: 'Додати Ошийок', exact: true }).click();
  await page.getByRole('button', { name: '400 г', exact: true }).click();
  await page.locator('#addBtn').click();
  await expect(page.locator('#barL')).toHaveText(/1 позиція/);

  /* кошик: друга позиція з підказок, більше ваги, прибрати рядок */
  await page.locator('#barBtn').click();
  await page.locator('.up-c', { hasText: 'Сулугуні' }).click();
  await expect(page.locator('#barL')).toHaveText(/2 позиції/);
  const total = async () => (await page.locator('#barR').innerText()).replace(/[^\d.]/g, '');
  const before = Number(await total());
  await page.locator('.qbtn[data-p="0"]').click();
  await expect.poll(async () => Number(await total())).toBeGreaterThan(before);
  await page.getByRole('button', { name: /^Прибрати Сулугуні/ }).click();
  await expect(page.locator('#barL')).toHaveText(/1 позиція/);

  /* оформлення: без імені не пускає */
  await checkout(page);
  await page.locator('#send').click();
  await expect(page.locator('#sheet')).toContainText(/імʼя|Імʼя/);
  await fillContacts(page, 'Тест Покупець', '+380501112233');
  await bot.clear();
  await page.locator('#send').click();
  await expect(page.locator('#sheet')).toContainText('ЗАМОВЛЕННЯ ОФОРМЛЕНО', { ignoreCase: true });
  const no = await orderNo(page);
  await expect(page.locator('#sheet')).toContainText('Ошийок · 500 г');

  /* точка отримала картку з кнопкою «Прийняти» */
  const card = (await bot.sent()).find(x => x.chatId === CHAT && new RegExp('№\\s*' + no).test(x.text));
  expect(card, 'картка в чаті точки').toBeTruthy();
  expect(card.text).toContain('+380501112233');
  expect(card.kb.some(b => b.callback_data === `s:${no}:accepted`)).toBe(true);

  /* оператор тисне «Прийняти» — сторінка покупця це бачить сама */
  await bot.press(CHAT, 5, `s:${no}:accepted`);
  /* сторінка питає сервер раз на 15 с — як і в людини на телефоні */
  await expect(page.locator('#sheet')).toContainText('оператор підтвердив', { timeout: 20000 });
  await page.reload();
  await expect(page.locator('#histTop')).toBeVisible();
  expect(errors, 'помилки JS на сторінці').toEqual([]);
});

test('вхід через Telegram: сайт упізнає покупця й підставляє номер', async ({ page, bot }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Додати Ошийок', exact: true }).click();
  await page.locator('#addBtn').click();
  await toCheckout(page);
  await page.locator('#ckIn').click();

  /* те, що покупець робить у Telegram: /start з посиланням і «Поділитися номером» */
  const link = await page.locator('#lgGo').getAttribute('href');
  const sid = link.match(/start=(\w+)/)[1];
  await bot.say(CLIENT, CLIENT, '/start ' + sid, 'private');
  await bot.contact(CLIENT, CLIENT, '380671234567', 'Олена');
  await expect(page.locator('#sheet')).toContainText('номер підтверджено Telegram', { timeout: 8000 });
  await expect(page.locator('#sheet')).toContainText('67 123 45 67');

  /* після входу оформлення вже знає номер, а сповіщення прийдуть у бот */
  await page.locator('.x').first().click();
  await toCheckout(page);
  await expect(page.locator('#sheet')).not.toContainText('Увійти через Telegram');
  if (await page.locator('#nm').isVisible()) await page.locator('#nm').fill('Олена');
  await bot.clear();
  await page.locator('#send').click();
  await expect(page.locator('#sheet')).toContainText('ЗАМОВЛЕННЯ ОФОРМЛЕНО', { ignoreCase: true });
  const no = await orderNo(page);
  await bot.press(CHAT, 5, `s:${no}:accepted`);
  const toClient = (await bot.sent()).filter(x => x.chatId === CLIENT);
  expect(toClient.length, 'покупцю в бот прийшло сповіщення').toBeGreaterThan(0);
});

test('доставка: без адреси не пускає, з адресою — у чаті точки', async ({ page, bot }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Доставка/ }).first().click();
  await page.getByRole('button', { name: 'Додати Ошийок', exact: true }).click();
  await page.locator('#addBtn').click();
  await toCheckout(page);
  await fillContacts(page, 'Тест Доставка', '+380671112244');
  await page.locator('#send').click();
  await expect(page.locator('#sheet')).not.toContainText('ЗАМОВЛЕННЯ ОФОРМЛЕНО', { ignoreCase: true });
  await page.locator('#addrStreet').fill('вул. Сумська');
  await page.locator('#addrHouse').fill('10');
  await bot.clear();
  await page.locator('#send').click();
  await expect(page.locator('#sheet')).toContainText('ЗАМОВЛЕННЯ ОФОРМЛЕНО', { ignoreCase: true });
  const no = await orderNo(page);
  const card = (await bot.sent()).find(x => x.chatId === CHAT && x.text.includes(String(no)));
  expect(card && card.text).toContain('Сумська');
});
