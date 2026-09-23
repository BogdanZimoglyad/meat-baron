/* Мʼясний Барон — service worker */

const CACHE = 'mb-v7';
const SHELL = [
  './',
  './index.html',
  './catalog.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  const isPage = e.request.mode === 'navigate' || url.pathname.endsWith('.html');
  const isCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.json');
  /* Довідник вулиць — 110 КБ, які майже не змінюються. Тягнути його
     щоразу на мобільному інтернеті нема сенсу, тож він іде тим самим
     шляхом, що й фото: з кеша одразу, оновлення — у фоні. */
  const isDict = url.pathname.endsWith('streets.js');

  /* Сторінка і код: мережа, але чекаємо на неї лише мить.

     Було просто «спершу мережа»: запуск з іконки на телефоні впирався
     в мобільний інтернет, і перші пів секунди екран стояв — власник
     назвав це мікрофризом (22.09). Тепер якщо копія вже є, чекаємо
     мережу 1,2 секунди й віддаємо що встигло; кеш оновлюється в будь-
     якому разі, тож наступний запуск буде зі свіжою версією. */
  const NET_WAIT = 1200;
  if ((isPage || isCode) && !isDict) {
    e.respondWith((async () => {
      const net = fetch(e.request).then(r => {
        /* Лише вдалі відповіді. Інакше сторінка помилки (скажімо, 404,
           поки GitHub перевстановлює домен) лягала в кеш і потім
           показувалась замість сайту без інтернету. */
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      });
      /* Прайс підключається з версією в адресі (catalog.js?v=…), тож
         точного збігу в кеші може не бути — тоді беремо копію без
         урахування «?v=»: без інтернету краще трохи старіший прайс,
         ніж порожня сторінка. */
      const hit = (await caches.match(e.request)) ||
                  (await caches.match(e.request, { ignoreSearch: true }));
      if (!hit) {
        try { return await net }
        catch (err) { return (await caches.match('./index.html')) || Response.error() }
      }
      const soon = await Promise.race([
        net.catch(() => null),
        new Promise(res => setTimeout(() => res(null), NET_WAIT))
      ]);
      return soon || hit;
    })());
    return;
  }

  /* Фото та іконки: показуємо з кеша одразу, але слідом тихо
     перевіряємо мережу і оновлюємо кеш.

     Раніше тут було просто «спершу кеш», із поміткою що фото не
     змінюються. Поки ми лише додавали нові файли, так і було. Але
     коли фото товару замінили, лишивши те саме імʼя, у всіх, хто вже
     заходив на сайт, назавжди лишалася стара картинка: до мережі
     запит не йшов узагалі.

     Тепер стара версія показується один раз, а на наступному відкритті
     вже нова. Ніяких ручних підвищень версії кеша для цього не треба. */
  e.respondWith(
    caches.match(e.request).then(hit => {
      /* Просимо саме звіритися з сервером, а не брати з кеша браузера.
         GitHub Pages віддає фото з дозволом тримати їх десять хвилин,
         і без цього фонова перевірка всі десять хвилин повертала б
         стару картинку — тобто оновлення знову б не дійшло.
         Це не повторне вивантаження: якщо файл не змінився, сервер
         відповідає «те саме» і тіла не надсилає. */
      const fromNet = fetch(e.request, { cache: 'no-cache' }).then(r => {
        if (r.ok && url.origin === location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      });
      // є в кеші — віддаємо миттєво, мережу довантажуємо у фоні
      if (hit) { fromNet.catch(() => {}); return hit; }
      return fromNet;
    })
  );
});
