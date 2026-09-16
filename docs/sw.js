/* TopTraders service worker.
 *
 * Network-first for everything, falling back to cache. The dashboard's whole
 * point is fresh data, and a cache-first shell would happily serve a stale app
 * for days after a deploy. Offline still works: you get the last version you
 * successfully loaded.
 */

const CACHE = 'toptraders-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/format.js',
  './js/liquidation.js',
  './js/venues/index.js',
  './js/venues/hyperliquid.js',
  './js/venues/hyperliquid-ws.js',
  './js/venues/gmx.js',
  './js/venues/okx.js',
  './js/venues/htx.js',
  './js/venues/bitget.js',
  './icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One bad URL must not fail the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only handle our own origin; exchange APIs must never be cached.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
  );
});

/* Web Push. Nothing sends these yet — delivering them needs a push service
 * holding subscriptions, which static hosting cannot provide. The handler is
 * here so that wiring one up later needs no service-worker change. */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(payload.title || 'TopTraders', {
    body: payload.body || 'A watched trader moved.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: payload.tag || 'toptraders',
    data: payload.data || {},
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow('./index.html') : undefined;
    }),
  );
});
