// Network-first for the app shell, cache as offline fallback.
// YouTube and the bundle CSVs are never cached here (bundles live in localStorage).
const CACHE = 'musicminds-v2';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-512.png', 'fonts/acme_regular.ttf', 'vendor/jsQR.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const cacheable = e.request.method === 'GET'
    && url.origin === self.location.origin;
  if (!cacheable) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
