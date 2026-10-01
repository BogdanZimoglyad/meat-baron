/* Сторінка статистики власника (stats.html): вхід лише за посиланням із
   /stats в особистих; цифри на плитках — ті самі, що рахує сервер;
   тестові замовлення не в цифрах, але видно у списку зі значком ТЕСТ. */
const { test, expect, OWNER } = require('./fixtures.js');
const CAT = require('../../catalog.js');

const osh = CAT.ITEMS.find(i => i.name === 'Ошийок');
const order = async (request, nm, note = '') => {
  const r = await request.post('/api/order', { data: {
    shop: 0, mode: 'pickup', pay: 'cash', nm, tel: '+380501119999', note,
    slotAt: Date.now() + 60e3, lines: [{ id: osh.id, g: 500 }], total: 0 } });
  expect(r.status(), 'сервер прийняв замовлення').toBe(200);
};

test('власник: плитки збігаються з сервером, тестове — лише в списку зі значком', async ({ page, bot, request }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await order(request, 'Статистика Звичайний');
  await order(request, 'Статистика Тестовий', 'тест, не готувати');

  await page.goto(await bot.link('/stats', OWNER, OWNER, 'private'));
  await page.locator('[data-p="today"]').click();
  const tile = page.locator('.tile').filter({ has: page.locator('.k', { hasText: /^Замовлень$/ }) }).locator('.v');
  await expect(tile).toBeVisible();

  /* те саме питаємо в сервера тим самим ключем, що записала сторінка */
  const token = await page.evaluate(() => localStorage.getItem('mb-stats-token'));
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  const s = await (await request.get(`/api/stats?from=${today}&to=${today}`, { headers: { Authorization: 'Bearer ' + token } })).json();
  await expect(tile).toHaveText(String(s.cur.n));
  expect(s.tests).toBeGreaterThan(0);
  await expect(page.locator('body')).toContainText('Тестових замовлень не враховано: ' + s.tests);

  await page.locator('[data-v="orders"]').click();
  const testRow = page.locator('body').getByText('Статистика Тестовий');
  await expect(testRow).toBeVisible();
  await expect(page.locator('.tb', { hasText: 'ТЕСТ' }).first()).toBeVisible();
  await expect(page.locator('body')).toContainText('Статистика Звичайний');
  expect(errors, 'помилки JS на сторінці').toEqual([]);
});

test('без посилання статистика не відкривається', async ({ page }) => {
  await page.goto('/stats.html');
  await expect(page.locator('.err')).toContainText('/stats');
  await expect(page.locator('.tile')).toHaveCount(0);
});
