// sw.js - offline shell. Classic worker, no imports.
// VERSION must equal APP_VERSION in version.js (the static test checks it).
// Once a version has been pushed, any change to a SHELL file ships under a new VERSION.
const VERSION = '0.4.0';
const CACHE = 'liftlog-' + VERSION;
// sha256 of every SHELL file (this one with this line removed). The static test
// recomputes it and fails on a mismatch, so a changed file forces a version bump.
const SHELL_HASH = '788ba80f650f290b48243955ae6fb188bb8c4dd557a624b15dfaab4899c8cdec';

// Every file the app serves. Must equal the git file list minus the files that
// are never shipped (static test). No other file holds this list.
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'version.js',
  'app.js',
  'db.js',
  'backup.js',
  'store.js',
  'rules.js',
  'engine.js',
  'stats.js',
  'data/exercises.js',
  'data/templates.js',
  'sw.js',
  'manifest.webmanifest',
  'ui/dom.js',
  'ui/strings.js',
  'ui/install.js',
  'ui/check.js',
  'ui/settings.js',
  'ui/today.js',
  'ui/builder.js',
  'ui/block.js',
  'ui/blocks.js',
  'ui/templates.js',
  'ui/guided.js',
  'ui/history.js',
  'ui/trend.js',
  'ui/library.js',
  'ui/tips.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// All or nothing: fetch every file fresh (the query makes any host cache treat it
// as a new address). If any one fails, or version.js is not this version, install
// fails and the old version keeps running. Nothing is written until all pass.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const got = await Promise.all(SHELL.map(async (u) => {
      const res = await fetch(u + '?v=' + VERSION, { cache: 'reload' });
      if (!res || !res.ok) throw new Error('install: could not fetch ' + u);
      // Read the body now: an unread body can hold the connection open and
      // stall the other fetches on a host that sends no-store.
      const body = await res.blob();
      return [u, new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })];
    }));
    const ver = got.find(([u]) => u === 'version.js');
    const text = ver ? await ver[1].clone().text() : '';
    if (!text.includes("APP_VERSION = '" + VERSION + "'")) throw new Error('install: version.js is not ' + VERSION);
    const cache = await caches.open(CACHE);
    await Promise.all(got.map(([u, res]) => cache.put(u, res)));
  })());
});

// Remove only our own old caches. Other apps on this address keep theirs.
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('liftlog-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Answer from the cache. Our own address only, GET only. Never write back.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      const page = await cache.match('index.html');
      if (page) return page;
      return fetch(req);
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    return fetch(req);
  })());
});

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'SHELL' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: VERSION, cache: CACHE, shell: SHELL.slice() });
  }
});
