import { defineConfig } from 'vitest/config';

/* Тести: tests/unit — окремі правила (функції вирізаємо зі справжніх
   server.js / index.html / op.html), tests/api — справжній server.js
   з підставним ботом. Запуск: npm test, з покриттям — npm run cover. */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.js', 'tests/api/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['server.js', 'catalog.js'],
      reporter: ['text-summary', 'text'],
      /* Нижче — прогін червоний: нові правила без тестів не проходять непомітно */
      thresholds: { lines: 50, statements: 50 }
    }
  }
});
