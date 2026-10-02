/* Перевірка правок складу замовлення на справжньому коді: вирізаємо з
   server.js retotal і applyLine і додаємо-прибираємо позиції в
   підставленому замовленні. Тут рахуються гроші клієнта, тож перевіряємо
   не лише «спрацювало», а й що саме вийшло в сумі.
   Запуск: npm test */
const fs = require('fs');
const report = require('../report.js');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const CAT = require(path.join(__dirname, '..', '..', 'catalog.js'));

const cut = re => { const m = src.match(re); if (!m) { throw new Error('не знайшли: ' + re) } return m[0] };
const code = [
  cut(/function qtyText\(l\) \{[\s\S]*?\n\}/),
  cut(/function fryOf\(lines\) \{[\s\S]*?\n\}/),
  cut(/function retotal\(o\) \{[\s\S]*?\n\}/),
  cut(/async function applyLine\(o, act, raw, by\) \{[\s\S]*?\n\}/)
].join('\n');

const byId = new Map(CAT.ITEMS.map(i => [i.id, i]));
const id = name => CAT.ITEMS.find(i => i.name === name).id;
const item = name => CAT.ITEMS.find(i => i.name === name);

let notified = [];
const env = {
  byId, kop: CAT.kop, lineSum: CAT.lineSum, priceOf: CAT.priceOf, lineTitle: CAT.lineTitle,
  variantsOf: CAT.variantsOf, canFry: CAT.canFry, fryableG: CAT.fryableG,
  portionOf: CAT.portionOf, countUnitOf: CAT.countUnitOf, packLabel: CAT.packLabel,
  MIN_G: CAT.MIN_G, FRY_RATE: CAT.FRY_RATE, MAX_TOTAL: 200000,
  money: n => CAT.kop(n).toFixed(2).replace(/\.00$/, '') + ' ₴',
  wLabel: g => (g >= 1000 ? (g / 1000).toFixed(g % 100 ? 2 : g % 1000 ? 1 : 0) + ' кг' : g + ' г'),
  esc: s => String(s),
  /* Вікно правок те саме, що й у суми: до «Готується» */
  canEdit: (o) => ['new', 'accepted'].includes(o.status),
  lockedText: () => 'Замовлення вже готується — суму й коментарі змінити не можна',
  adjustmentsOf: o => (Array.isArray(o.adjust) ? o.adjust : []),
  save: () => {},
  editCard: async () => {},
  notifyAdjust: (o, a) => notified.push(a)
};
const api = new Function(...Object.keys(env), `${code}; return { retotal, applyLine, qtyText }`)(...Object.values(env));

const line = (name, g, fry) => {
  const it = item(name);
  return {
    name: it.name, grp: it.grp, cat: it.cat, unit: it.unit, id: it.id, g,
    sum: CAT.lineSum({ unit: it.unit, price: it.price, g, grp: it.grp, name: it.name }),
    fry: !!fry
  };
};
const order = (over = {}) => {
  const o = { no: 1, status: 'accepted', ship: 0, lines: [line('Ошийок', 1000)], ...over };
  o.total = api.retotal(o);
  o.totalOrig = o.total;
  return o;
};

const t = [];
const ok = (name, cond) => t.push([name, cond]);
const round = n => Math.round(n * 100) / 100;

{
  // ---------- додавання ----------
  let o = order();
  const was = o.total;
  let r = await api.applyLine(o, 'add', { id: id('Сулугуні'), g: 500 }, 'панель');
  ok('позиція додалась', r.ok && o.lines.length === 2);
  ok('сума виросла рівно на ціну позиції',
    round(o.total) === round(was + o.lines[1].sum));
  ok('у журналі змін названо, що саме додали',
    notified.length === 1 && notified[0].note.includes('Сулугуні') && notified[0].kind === 'add');
  ok('у журналі — різниця, а не ціна', round(notified[0].amount) === round(o.total - was));

  /* Додали мʼясо на мангал — виросла ще й вартість смаження. Саме тому
     в журнал пишемо різницю сум, а не ціну рядка. */
  notified = [];
  o = order();
  const before = o.total;
  r = await api.applyLine(o, 'add', { id: id('Мʼякоть'), g: 1000, fry: true }, 'панель');
  const added = o.lines[1].sum;
  ok('на мангал: сума виросла більше за ціну позиції', o.total - before > added);
  ok('вага на мангал перерахована', o.fg === 1000 && o.fry === true);
  ok('різниця в журналі враховує смаження',
    round(notified[0].amount) === round(o.total - before));

  // ---------- межі ----------
  o = order();
  r = await api.applyLine(o, 'add', { id: id('Ошийок'), g: 50 }, 'п');
  ok('менше мінімальної ваги — відмова', !!r.err && o.lines.length === 1);
  r = await api.applyLine(o, 'add', { id: 'немає-такого', g: 500 }, 'п');
  ok('позиції не з прайсу не приймаємо', !!r.err && o.lines.length === 1);
  const sauce = CAT.ITEMS.find(i => CAT.variantsOf(i));
  if (sauce) {
    r = await api.applyLine(o, 'add', { id: sauce.id, g: 1 }, 'п');
    ok('соус без вибраного різновиду — відмова', !!r.err);
    r = await api.applyLine(o, 'add', { id: sauce.id, g: 1, v: CAT.variantsOf(sauce).list[0][0] }, 'п');
    ok('соус із різновидом додається', r.ok && o.lines[o.lines.length - 1].v);
  }

  // ---------- прибирання ----------
  o = order({ lines: [line('Ошийок', 1000), line('Сулугуні', 500)] });
  const full = o.total;
  const gone = o.lines[1].sum;
  notified = [];
  r = await api.applyLine(o, 'del', { i: 1 }, 'панель');
  ok('позиція прибралась', r.ok && o.lines.length === 1);
  ok('сума впала рівно на ціну прибраного', round(o.total) === round(full - gone));
  ok('у журналі сказано, що прибрали й що саме',
    notified[0].kind === 'sub' && notified[0].note.includes('прибрали') && notified[0].note.includes('Сулугуні'));

  /* Причина не обовʼязкова, але коли вона є — клієнт має її побачити */
  o = order({ lines: [line('Ошийок', 1000), line('Сулугуні', 500)] });
  notified = [];
  await api.applyLine(o, 'del', { i: 1, note: 'закінчилось' }, 'панель');
  ok('причина прибирання доходить до клієнта',
    notified[0].note.includes('прибрали') && notified[0].note.includes('закінчилось'));

  o = order({ lines: [line('Ошийок', 1000), line('Сулугуні', 500)] });
  notified = [];
  await api.applyLine(o, 'del', { i: 1 }, 'панель');
  ok('без причини — просто назва позиції', !notified[0].note.includes('—'));

  o = order();
  r = await api.applyLine(o, 'del', { i: 0 }, 'п');
  ok('останню позицію прибрати не даємо — це скасування', !!r.err && o.lines.length === 1);
  r = await api.applyLine(o, 'del', { i: 7 }, 'п');
  ok('неіснуючий рядок не ламає замовлення', !!r.err && o.lines.length === 1);

  // ---------- вікно правок ----------
  o = order({ status: 'cooking' });
  r = await api.applyLine(o, 'add', { id: id('Сулугуні'), g: 500 }, 'п');
  ok('після «Готується» склад не міняють', !!r.err && o.lines.length === 1);

  // ---------- ціну бере сервер ----------
  o = order();
  await api.applyLine(o, 'add', { id: id('Сулугуні'), g: 500, sum: 1, price: 1 }, 'п');
  const real = CAT.lineSum({ unit: item('Сулугуні').unit, price: item('Сулугуні').price, g: 500,
    grp: item('Сулугуні').grp, name: 'Сулугуні' });
  ok('ціну з браузера ігноруємо — рахуємо з прайсу', round(o.lines[1].sum) === round(real));

  /* Оператор зважив на касі й виправив суму, а потім клієнт попросив
     ще позицію. Поправка з каси має лишитись: спершу тут рахувалось
     усе наново з рядків, і сорок гривень зникали (знайдено 28.09). */
  o = order();
  const fact = CAT.kop(o.total + 40);
  o.total = fact;
  o.adjust = [{ kind: 'fact', amount: fact, from: o.totalOrig, note: 'зважили' }];
  await api.applyLine(o, 'add', { id: id('Сулугуні'), g: 500 }, 'п');
  ok('поправка з каси не зникає після додавання позиції',
    round(o.total) === round(fact + o.lines[1].sum));

  o = order({ lines: [line('Ошийок', 1000), line('Сулугуні', 500)] });
  const fact2 = CAT.kop(o.total + 40);
  o.total = fact2;
  const dropped = o.lines[1].sum;
  await api.applyLine(o, 'del', { i: 1 }, 'п');
  ok('і після прибирання теж', round(o.total) === round(fact2 - dropped));

  // ---------- доставка не губиться ----------
  o = order({ ship: 150 });
  const withShip = o.total;
  ok('вартість доставки входить у суму', withShip > o.lines[0].sum);
  await api.applyLine(o, 'add', { id: id('Сулугуні'), g: 500 }, 'п');
  ok('після правки складу доставка лишилась', round(o.total - withShip) === round(o.lines[1].sum));

  /* ---------- змінити вагу чи кількість, не прибираючи позицію (02.10) ---------- */
  notified = [];
  o = order();
  let bef = o.total;
  r = await api.applyLine(o, 'set', { i: 0, g: 1500 }, 'панель');
  ok('вагу змінено на місці, позиція одна', r.ok && o.lines.length === 1 && o.lines[0].g === 1500);
  ok('сума виросла рівно на пів кіло ошийка',
    round(o.total - bef) === round(CAT.lineSum({ ...item('Ошийок'), g: 500 })));
  ok('у журналі — було й стало',
    notified[0] && notified[0].kind === 'add' && notified[0].note.includes('змінили') && notified[0].note.includes('→'));
  bef = o.total;
  r = await api.applyLine(o, 'set', { i: 0, g: 700, note: 'зважили' }, 'панель');
  ok('менше — сума впала, причина в журналі',
    r.ok && o.total < bef && notified[1].kind === 'sub' && notified[1].note.includes('зважили'));
  /* ціна — та, за якою замовляли, а не сьогоднішня з прайсу */
  o = order();
  o.lines[0].sum = 100; o.total = 100; o.totalOrig = 100;
  await api.applyLine(o, 'set', { i: 0, g: 2000 }, 'п');
  ok('ціна з рядка замовлення', o.lines[0].sum === 200 && o.total === 200);
  /* на мангал — смаження рахується від нової ваги */
  o = order({ lines: [line('Ошийок', 1000, true)] });
  o.total = api.retotal(o);
  const fryWas = o.fg;
  await api.applyLine(o, 'set', { i: 0, g: 2000 }, 'п');
  ok('вага на мангал перерахована', o.fg === 2000 && o.fg !== fryWas);
  o = order();
  r = await api.applyLine(o, 'set', { i: 0, g: 1000 }, 'п');
  ok('та сама кількість — відмова', !!r.err);
  r = await api.applyLine(o, 'set', { i: 0, g: 10 }, 'п');
  ok('менше мінімуму — відмова', !!r.err && o.lines[0].g === 1000);
  r = await api.applyLine(o, 'set', { i: 5, g: 500 }, 'п');
  ok('неіснуючий рядок — відмова', !!r.err);
  o = order({ status: 'cooking' });
  r = await api.applyLine(o, 'set', { i: 0, g: 500 }, 'п');
  ok('після «Готується» — ні', !!r.err && o.lines[0].g === 1000);
  o = order({ packedAt: 1 });
  await api.applyLine(o, 'set', { i: 0, g: 500 }, 'п');
  ok('змінили вагу — «Зібрано» знято', !o.packedAt);

  /* Склад змінився — зібраний пакет уже не той: «Зібрано» знімається */
  o = order({ packedAt: Date.now() });
  await api.applyLine(o, 'add', { id: id('Сулугуні'), g: 500 }, 'п');
  ok('додали позицію — «Зібрано» знято', !o.packedAt);
  o = order({ packedAt: Date.now() });
  o.lines.push(line('Сулугуні', 500));
  await api.applyLine(o, 'del', { i: 1 }, 'п');
  ok('прибрали позицію — теж знято', !o.packedAt);
  o = order({ status: 'cooking', packedAt: 5 });
  await api.applyLine(o, 'add', { id: id('Сулугуні'), g: 500 }, 'п');
  ok('правку відхилено — «Зібрано» лишилось', o.packedAt === 5);

  /* Назва в картці зрозуміла без групи: «З сиром» не плутається з
     курячою ковбаскою з сиром (власник, 02.10) */
  ok('чевапчічі — з назвою групи', CAT.lineTitle(item('З сиром')) === 'Чевапчічі з сиром');
  ok('ковбаски — теж', CAT.lineTitle(item('Куряча з сиром')) === 'Куряча ковбаска з сиром');
  ok('у журналі змін — повна назва', await (async () => {
    notified = [];
    const c = order({ lines: [line('З сиром', 850)] });
    c.total = api.retotal(c);
    await api.applyLine(c, 'set', { i: 0, g: 1000 }, 'п');
    return notified[0] && notified[0].note.includes('Чевапчічі з сиром');
  })());

  report(t);
}
