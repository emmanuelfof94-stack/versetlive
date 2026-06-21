// VersetLive — Service Worker
// Stratégie : pré-cache au premier chargement + cache-first pour les logos
// (rarement modifiés) + network-first avec fallback cache pour le reste
// (les mises à jour arrivent immédiatement en ligne, et l'app reste utilisable hors-ligne).

const CACHE_VERSION = 'v11';
const CACHE_NAME = `versetlive-${CACHE_VERSION}`;

// Assets pré-chargés à l'installation. Tout ce qui est indispensable pour qu'une
// page principale s'ouvre hors-ligne. Les fichiers manquants ne bloquent pas
// l'installation (catch sur chaque add).
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/studio.html',
  '/obs.html',
  '/tv.html',
  '/studio-output.html',
  '/presenter.html',
  '/studio-camera.html',
  '/cv-paroles.html',

  '/style.css',

  '/app.js',
  '/studio.js',
  '/coop.js',
  '/obs.js',
  '/obs-control.js',
  '/titles.js',
  '/titles-data.js',
  '/songs.js',
  '/songs-data.js',
  '/bible-data.js',
  '/videos.js',
  '/intro-outro.js',
  '/timer.js',
  '/presenter.js',
  '/studio-camera.js',
  '/songselect-import.js',
  '/youtube-scheduler.js',
  '/peerjs.min.js',
  '/qrcode.js',
  '/chants-cv-data.js',

  // Logos AD Broukoi-Jérusalem (déjà servis avec cache-first ci-dessous)
  '/logo-ad.png',
  '/logo-ad-bible-flame.svg',
  '/logo-ad-cross-globe.svg',
  '/logo-ad-dove.svg',
  '/logo-ad-seal.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] precache miss:', url, err.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function shouldBypass(url) {
  if (url.origin !== self.location.origin) return true;          // CDN tiers
  if (url.pathname.startsWith('/_vercel/')) return true;         // Analytics Vercel
  if (url.pathname.startsWith('/api/'))     return true;         // Endpoints API
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (shouldBypass(url)) return;

  const isLogo = /^\/logo-ad[\w.-]*\.(png|svg|jpg|jpeg)$/i.test(url.pathname);

  if (isLogo) {
    // Cache-first : les logos changent très rarement, on évite tout aller-retour réseau.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Network-first avec fallback cache : on a toujours la version à jour quand
  // on est en ligne, et l'app reste utilisable quand le réseau coupe.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
  );
});

// Permet au panneau de demander une mise à jour forcée du cache.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
