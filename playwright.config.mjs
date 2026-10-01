import { defineConfig, devices } from '@playwright/test';

/* Тести в браузері: сайт, панель точки, статистика власника на
   справжньому server.js із підставним ботом (tests/ui/serve.js).
   Запуск: npm run ui   (звіт із кроками й знімками — npx playwright show-report) */
const PORT = 38790;

export default defineConfig({
  testDir: 'tests/ui',
  /* одна база на всі тести — по черзі, щоб замовлення не перемішались */
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    /* покупці — переважно з телефона */
    { name: 'телефон', use: { ...devices['Pixel 7'] }, testMatch: /site\..*\.js/ },
    /* панель — планшет/монітор точки, статистика — власник */
    { name: 'планшет', use: { viewport: { width: 1280, height: 800 } }, testIgnore: /site\..*\.js/ }
  ],
  webServer: {
    command: 'node tests/ui/serve.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { UI_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 20_000
  }
});
