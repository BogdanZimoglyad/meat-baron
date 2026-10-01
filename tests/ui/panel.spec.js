/* Панель точки (op.html) очима оператора на планшеті: вхід за посиланням
   з /panel, замовлення від «Нове» до «Видано» з правкою суми й складу,
   скасування з причиною, стоп-лист, який одразу бачить сайт, мангал.
   Замовлення створюємо так само, як сайт, — запитом до /api/order. */
const { test, expect, CHAT } = require('./fixtures.js');
const CAT = require('../../catalog.js');

const osh = CAT.ITEMS.find(i => i.name === 'Ошийок');
const newOrder = async (request, nm) => {
  const r = await request.post('/api/order', { data: {
    shop: 0, mode: 'pickup', pay: 'cash', nm, tel: '+380501110000', note: '',
    /* за хвилину: кнопки «Готується» й далі вже живі, день — сьогоднішній */
    slotAt: Date.now() + 60e3, lines: [{ id: osh.id, g: 500 }], total: 0 } });
  expect(r.status(), 'сервер прийняв замовлення').toBe(200);
  return (await r.json()).no;
};
const statusOf = async (request, no) => (await (await request.get('/api/order/' + no)).json()).status;
const openPanel = async (page, bot) => {
  await page.goto(await bot.link('/panel', CHAT, 1, 'group'));
  await expect(page.locator('[data-view="orders"]')).toBeVisible();
};
const cardOf = (page, no) => page.locator(`[data-card="${no}"]`);

test('оператор: «Нове» → сума й склад → «Видано»', async ({ page, bot, request }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const no = await newOrder(request, 'Панель Перший');
  await openPanel(page, bot);
  const card = cardOf(page, no);
  await expect(card).toContainText('Панель Перший');
  await expect(card).toContainText('050 111 00 00');

  await card.locator(`[data-go="${no}"]`).click();               // ✅ Прийняти в роботу
  await expect.poll(() => statusOf(request, no)).toBe('accepted');

  /* 🧾 сума з комою — як дає десяткова клавіша планшета */
  await card.locator('[data-kind="fact"]').click();
  await page.locator('#fv').fill('150,50');
  await page.locator('[data-send][data-kind="fact"]').click();
  await expect(card).toContainText('150.50');

  /* ➕ позиція: пошук → обрати → вага → додати */
  await card.locator('[data-kind="plus"]').click();
  await page.locator('#fv').fill('віденська');
  await page.locator('[data-pick]').first().click();
  await page.locator('[data-q="500"]').click();
  await page.locator('[data-addline]').click();
  await expect(card).toContainText('Віденська');

  /* далі по кроках до видачі — головна кнопка щоразу наступна */
  for (const st of ['cooking', 'ready', 'done']) {
    await page.locator(`[data-go="${no}"][data-st="${st}"]`).click();
    await expect.poll(() => statusOf(request, no)).toBe(st);
  }
  /* видане — у «Завершені», а не серед робочих */
  await page.locator('[data-grp="done"]').click();
  await expect(page.locator('body')).toContainText('Панель Перший');
  expect(errors, 'помилки JS у панелі').toEqual([]);
});

test('оператор: скасування з причиною — потрібна причина, далі замовлення закрите', async ({ page, bot, request }) => {
  /* панель питає системними вікнами: без причини — alert, далі confirm «Скасувати?» */
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept() });
  const no = await newOrder(request, 'Панель Скасування');
  await openPanel(page, bot);
  const card = cardOf(page, no);
  await card.locator('[data-kind="cancel"]').click();
  await page.locator('[data-send][data-kind="cancel"]').click();     // без причини — не скасовує
  await expect.poll(() => statusOf(request, no)).toBe('new');
  await page.locator('#fv').fill('немає в наявності');
  await page.locator('[data-send][data-kind="cancel"]').click();
  await expect.poll(() => statusOf(request, no)).toBe('canceled');
  expect(dialogs[0]).toContain('причину');
  expect(dialogs[1]).toContain('Скасувати замовлення № ' + no);
});

test('стоп-лист у панелі одразу ховає позицію на сайті', async ({ page, bot }) => {
  await openPanel(page, bot);
  await page.locator('[data-view="stock"]').click();
  await page.locator('#sq').fill('ошийок');
  await page.locator(`[data-stock="${osh.id}"][data-off="1"]`).click();

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Додати Ошийок', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).toContainText('Сьогодні немає');

  /* повертаємо — панель відкривається за збереженим ключем, без нового посилання */
  await page.goto('/op.html');
  await page.locator('[data-view="stock"]').click();
  await page.locator('#sq').fill('ошийок');
  await page.locator(`[data-stock="${osh.id}"]:not([data-off="1"])`).click();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Додати Ошийок', exact: true })).toBeVisible();
});

test('мангал: «зайнятий на годину» і назад «вільний»', async ({ page, bot, request }) => {
  await openPanel(page, bot);
  await page.locator('[data-view="grill"]').click();
  await page.locator('[data-grill="60"]').click();
  await expect.poll(async () => (await (await request.get('/api/grill?shop=0')).json()).busyUntil).toBeGreaterThan(Date.now() + 50 * 60e3);
  await page.locator('[data-grill="free"]').click();
  await expect.poll(async () => (await (await request.get('/api/grill?shop=0')).json()).busyUntil).toBeLessThan(Date.now());
});

test('чуже чи використане посилання панель не відкриває', async ({ page, bot }) => {
  const link = await bot.link('/panel', CHAT, 1, 'group');
  await page.goto(link.replace(/#.*/, '#0000000000'));
  await expect(page.locator('.enter')).toContainText('застаріло');
  await expect(page.locator('[data-card]')).toHaveCount(0);
});
