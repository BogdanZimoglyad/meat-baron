/* Цифри каси (01.10): як бот розбирає відповідь оператора «кількість сума».
   Функцію вирізаємо з server.js. Запуск: npm test */
const fs = require('fs');
const report = require('../report.js');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = re => { const m = src.match(re); if (!m) { throw new Error('не знайшли: ' + re) } return m[0] };
const { kop } = require(path.join(__dirname, '..', '..', 'catalog.js'));
const parseKassa = new Function('kop', cut(/const KASSA_MAX_N = [^\n]*/) + '\n' + cut(/function parseKassa\(text\) \{[\s\S]*?\n\}/) + '; return parseKassa')(kop);

const t = [];
const is = (n, text, want) => { const g = parseKassa(text); t.push([n + ` («${text}»)`, JSON.stringify(g) === JSON.stringify(want)]) };
is('звичайно', '54 48210', { n: 54, sum: 48210 });
is('з копійками через кому', '54 48210,50', { n: 54, sum: 48210.5 });
is('через кому між числами', '54, 48210', { n: 54, sum: 48210 });
is('з гривнями', '12 9800 грн', { n: 12, sum: 9800 });
is('зі значком', '12 9800₴', { n: 12, sum: 9800 });
is('нуль замовлень', '0 0', { n: 0, sum: 0 });
is('замовлення без суми — помилка', '5 0', null);
is('сума без замовлень — помилка', '0 500', null);
is('лише одне число', '54', null);
is('слова', 'сьогодні 54', null);
is('сума з пробілом-тисячами не вгадується', '54 48 210', null);
is('забагато замовлень', '5000 100000', null);

report(t);
