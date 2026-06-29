const CACHE = 'flux-rss-v25';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './update-check.js',
  './data/feeds.json', './data/events.json', './data/rugby_tv.json', './manifest.webmanifest',
  './img/icon-192.png', './img/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // coque applicative : cache-first ; flux distants : on laisse passer (gérés par l'app)
  if (url.origin === location.origin){
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
