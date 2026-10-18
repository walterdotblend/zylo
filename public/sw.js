// Zylo PWA Service Worker
const CACHE_NAME = 'zylo-pwa-v1';
const ASSETS = [
  '/app',
  '/i18n.js',
  '/local_encoder.js',
  '/favicon.png?v=5',
  '/icon-192.png?v=5',
  '/icon-512.png?v=5',
  '/logo.png?v=5',
  '/logo-outline.png?v=5',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/') || event.request.url.includes('/v/')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
