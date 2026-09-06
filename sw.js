// VersetLive — Service Worker
// Stratégie : pré-cache au premier chargement + cache-first pour les logos
// (rarement modifiés) + network-first avec fallback cache pour le reste
// (les mises à jour arrivent immédiatement en ligne, et l'app reste utilisable hors-ligne).

const CACHE_VERSION = 'v30';
const CACHE_NAME = `versetlive-${CACHE_VERSION}`;

// Cache SÉPARÉ et NON versionné pour les ressources tierces indispensables à une
// projection : chapitres bibliques (API bolls.life) et polices Google Fonts.
// Séparé, car il ne doit PAS être vidé à chaque déploiement : ce qui a été
// consulté une fois doit rester disponible si le réseau tombe pendant un culte
// ou un camp. Voir handleThirdParty() plus bas.
const EXTERNAL_CACHE = 'versetlive-externe';

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
        // EXTERNAL_CACHE survit aux déploiements : c'est le filet hors-ligne
        // (versets déjà consultés + polices de la projection).
        keys.filter((k) => k !== CACHE_NAME && k !== EXTERNAL_CACHE).map((k) => caches.delete(k))
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

// Ressources tierces qu'une projection ne peut pas se permettre de perdre :
//   - bolls.life : le TEXTE des versets. Sans cache, une coupure wifi de dix
//     secondes suffit à bloquer le passage en cours (l'opérateur n'a plus que
//     la saisie manuelle).
//   - Google Fonts : la typographie de l'écran projeté (tv.html, obs.html,
//     presenter.html). Sans cache, un réseau lent retarde l'affichage.
function isCacheableThirdParty(url) {
  const h = url.hostname;
  return h === 'bolls.life' || h.endsWith('.bolls.life')
      || h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com';
}

// Réseau d'abord (le texte servi doit rester le bon), cache en filet.
// Le réseau a 6 s pour répondre : au-delà, on sert la version en cache plutôt
// que de laisser l'opérateur devant un « Chargement… » qui ne finit jamais.
const THIRD_PARTY_TIMEOUT_MS = 6000;
function handleThirdParty(req) {
  const fromCache = () => caches.open(EXTERNAL_CACHE).then((c) => c.match(req));

  const network = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), THIRD_PARTY_TIMEOUT_MS);
    fetch(req).then((res) => { clearTimeout(timer); resolve(res); },
                    (err) => { clearTimeout(timer); reject(err); });
  });

  return network
    .then((res) => {
      // Une réponse opaque (no-cors) est inutilisable en repli : on ne la garde pas.
      if (res && res.status === 200 && res.type !== 'opaque') {
        const clone = res.clone();
        caches.open(EXTERNAL_CACHE).then((c) => c.put(req, clone)).catch(() => {});
      }
      return res;
    })
    .catch(() => fromCache().then((cached) => {
      if (cached) return cached;
      // Rien en cache : renvoyer une erreur explicite plutôt qu'un échec réseau
      // brut, pour que le message affiché à l'opérateur soit compréhensible.
      return new Response(
        JSON.stringify({ error: 'hors-ligne', message: 'Ressource indisponible hors-ligne et absente du cache' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  // Tiers indispensables à la projection : traités AVANT shouldBypass, qui
  // laisserait passer tout le cross-origin sans filet.
  if (isCacheableThirdParty(url)) { event.respondWith(handleThirdParty(req)); return; }
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
