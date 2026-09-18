/* ================================================================
   sw.js — Service Worker для RotaCol (agent.html + dispatcher.html)
   Стратегии:
     • навигация (HTML)        → network-first, fallback = кэш
     • свои файлы              → stale-while-revalidate
     • CDN (MQTT.js, Leaflet)  → stale-while-revalidate
     • тайлы карт              → cache-first + ограничение размера
   ================================================================ */

const VERSION = 'v1.0.0';                 // ← менять при каждом обновлении кода
const CORE    = 'rotacol-core-'  + VERSION;
const CDN     = 'rotacol-cdn-'   + VERSION;
const TILES   = 'rotacol-tiles-' + VERSION;
const KEEP    = [CORE, CDN, TILES];
const MAX_TILES = 400;

/* Что кладём в кэш сразу при установке */
const CORE_ASSETS = [
  './agent.html',
  './dispatcher.html',
  './pwa.js',
  './manifest-agent.json',
  './manifest-dispatcher.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png'
];

const CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com'
];

/* ---------------- install ---------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE);
    // качаем по одному: если какого-то файла нет — установка не падает
    await Promise.all(CORE_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (e) { /* ignore */ }
    }));
    // не вызываем skipWaiting() — ждём команды со страницы,
    // чтобы не выкинуть пользователя из активной сессии
  })());
});

/* ---------------- activate ---------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (KEEP.includes(k) ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

/* ---------------- сообщения со страницы ---------------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'PING' && event.source) {
    event.source.postMessage({ type: 'PONG', version: VERSION });
  }
});

/* ---------------- fetch ---------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. Переход по страницам
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNav(req));
    return;
  }

  // 2. Свои файлы (pwa.js, манифесты, иконки)
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, CORE));
    return;
  }

  // 3. CDN библиотек
  if (CDN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(staleWhileRevalidate(req, CDN));
    return;
  }

  // 4. Тайлы карт и прочие картинки
  if (req.destination === 'image') {
    event.respondWith(cacheFirstImage(req, TILES, MAX_TILES));
    return;
  }

  // 5. Остальное — напрямую в сеть (в т.ч. wss:// MQTT)
});

/* ---------------- стратегии ---------------- */

async function networkFirstNav(req) {
  const cache = await caches.open(CORE);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    const isDisp = /dispatcher/i.test(new URL(req.url).pathname);
    const fb = await cache.match(isDisp ? './dispatcher.html' : './agent.html');
    if (fb) return fb;

    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="background:#0b1220;color:#e5e7eb;font:16px system-ui;padding:32px;text-align:center">' +
      '<h1>📡 Нет сети</h1><p>Страница не загружена в кэш.<br>Подключитесь к интернету и обновите.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  const network = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  if (cached) return cached;
  const fresh = await network;
  return fresh || new Response('', { status: 504, statusText: 'Offline' });
}

async function cacheFirstImage(req, cacheName, maxEntries) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone())
        .then(() => trimCache(cacheName, maxEntries))
        .catch(() => {});
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) {
    await cache.delete(keys[i]);
  }
}
