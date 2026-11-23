// MusicMinds service worker.
//
// VERSION is replaced with the commit hash by the deploy workflow. Every deploy
// therefore yields a new sw.js, which the page notices and offers as an update.
// Unreplaced (local development) it stays '__BUILD__' and everything is
// network-first so edits show up on reload.
const VERSION = '__BUILD__';
const DEV = VERSION.startsWith('__');
const CACHE = 'musicminds-' + VERSION;

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'vendor/jsQR.js',
  'fonts/acme_regular.ttf',
  'icons/icon.svg',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  // No skipWaiting here: the page asks for it once the user accepts the update.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('musicminds-') && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' && await cache.match('./'));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true })
    || (req.mode === 'navigate' && await cache.match('./'));
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only the app's own files. YouTube and the bundle CSVs (GitHub) pass through.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Production serves the whole app from one versioned cache, so index.html and
  // app.js always belong together; a new deploy arrives as a new service worker.
  e.respondWith(DEV ? networkFirst(req) : cacheFirst(req));
});
