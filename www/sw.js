const CACHE = 'flux-rss-app-v5.41';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './autobackup.js',
  './data/feeds.json', './data/events.json', './data/rugby_tv.json', './manifest.webmanifest',
  './img/icon-192.png', './img/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // clients.claim() déclenche 'controllerchange' dans les pages ouvertes,
  // qui rechargent déjà elles-mêmes (voir app.js) — inutile de forcer une
  // navigation ici en plus, ça double le rechargement.
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // coque applicative : cache-first ; flux distants : on laisse passer (gérés par l'app)
  if (url.origin === location.origin){
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
