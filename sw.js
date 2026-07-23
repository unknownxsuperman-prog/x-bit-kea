const CACHE_NAME = 'xbit-proton-v1';
const ASSETS = [
  './',
  './index.html',
  './logo.svg',
  './logo.png',
  './logo1.png',
  './loading.html',
  './loading1.html',
  './firstroundeng.js',
  './firstroundenghk.js',
  './branch-aliases.json',
  './trainingset.json',
  './trainingset1.json'
  // If you have other assets (like fonts, etc.), add them here
];

// Install – cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching assets');
        return cache.addAll(ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate – clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch – serve from cache, fallback to network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(response => {
            // Cache any new assets (optional)
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Offline fallback (optional)
            return new Response('Offline – please connect to the internet', { status: 503 });
          });
      })
  );
});
