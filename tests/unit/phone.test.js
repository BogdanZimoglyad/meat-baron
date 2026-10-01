/* Номер телефону: як сайт (normPhone/fmtPhone в index.html) і сервер
   (normTel у server.js) розбирають те, що людина набрала чи вставила.
   Поле саме ставить «+380 », і вставлений повний номер раніше
   дописувався після нього — оператор отримував чужий номер (01.10).
   Запуск: npm test */
const fs = require('fs');
const path = require('path');
const report = require('../report.js');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (s, re) => { const m = s.match(re); if (!m) throw new Error('не знайшли: ' + re); return m[0] };

const site = new Function(cut(html, /function normPhone\(v\)\{[\s\S]*?\n\}/) + '\n' +
  cut(html, /function fmtPhone\(v\)\{[\s\S]*?\n\}/) + '; return { normPhone, fmtPhone }')();
const normTel = new Function(cut(src, /const normTel = t => \{[\s\S]*?\n\};/) + '; return normTel')();

const t = [];
const FULL = '501112233';

/* поле після дотику — «+380 », далі вставка з буфера чи підказки клавіатури */
for (const pasted of ['+380501112233', '380501112233', '0501112233', '050 111 22 33', '+38 (050) 111-22-33', '80501112233', '501112233']) {
  const field = site.fmtPhone('+380 ' + pasted);
  t.push([`вставили «${pasted}» після «+380 » → ${field}`, site.normPhone(field) === FULL && field === '+380 50 111 22 33']);
  t.push([`сервер: «+380 ${pasted}»`, normTel('+380 ' + pasted) === FULL]);
}

/* набір по цифрі, як на клавіатурі телефона: поле переформатовується після кожної */
const typed = start => [...FULL].reduce((v, ch) => site.fmtPhone(v + ch), start);
t.push(['набір по цифрі після «+380 »', typed('+380 ') === '+380 50 111 22 33']);
t.push(['набір по цифрі в порожнє поле', typed('') === '+380 50 111 22 33']);
t.push(['зайва цифра в кінці не зсуває номер', site.normPhone('+380 50 111 22 334') === FULL]);
t.push(['нуль першим після «+380 » — не потрапляє в номер', site.fmtPhone('+380 0') === '' && typed(site.fmtPhone('+380 0')) === '+380 50 111 22 33']);

/* сервер — ті самі відповіді, що й сайт: інакше вхід через Telegram і
   замовлення з сайту вели б одного покупця під двома номерами */
for (const v of ['+380501112233', '0501112233', '+380 0501112233', '8 050 111 22 33', '+380 38 050 11 12'])
  t.push([`сайт і сервер однаково: ${v}`, site.normPhone(v) === normTel(v)]);
t.push(['Telegram надсилає номер без плюса', normTel('380501112233') === FULL]);

report(t);
