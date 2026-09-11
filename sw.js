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

  // Сторінка і код: спершу мережа, кеш лише коли інтернету немає
  if (isPage || isCode) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
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
