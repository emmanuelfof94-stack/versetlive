// VersetLive — Enregistrement du Service Worker (hors-ligne + cache logos)
// Inclus depuis index.html, studio.html, obs.html, tv.html, studio-output.html.
// Pas d'enregistrement si navigateur sans support ou si on est sur localhost
// en mode incognito (le SW peut planter dans certains contextes restrictifs).
//
// Mise à jour automatique : quand un nouveau Service Worker prend le relais
// (skipWaiting + clients.claim côté sw.js), la page tourne encore avec l'ANCIEN
// code en mémoire. On recharge donc automatiquement — SAUF si la page est
// « occupée » (en direct / en enregistrement / studio configuré) : on affiche
// alors une bannière « Nouvelle version — recharger » que l'opérateur clique
// quand c'est sans risque. Les écrans de sortie (TV/projecteur) déclarent
// window.VL_NO_AUTORELOAD = true → ni rechargement auto ni bannière (silencieux,
// pour ne jamais clignoter / afficher de bandeau sur la projection).
(function () {
  if (!('serviceWorker' in navigator)) return;

  var refreshing = false;
  // Y avait-il déjà un SW au chargement ? Si non, le tout premier controllerchange
  // correspond à la prise de contrôle initiale (pas une mise à jour) → on l'ignore.
  var hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshing) return;
    if (!hadController) { hadController = true; return; } // prise de contrôle initiale
    refreshing = true;
    handleUpdate();
  });

  function handleUpdate() {
    // Écrans de sortie (TV / projecteur) : ne jamais perturber l'affichage.
    if (window.VL_NO_AUTORELOAD) return;
    // La page peut déclarer qu'elle est occupée (studio en direct / configuré).
    var busy = false;
    try {
      busy = !!(window.VL && typeof window.VL.isBusy === 'function' && window.VL.isBusy());
    } catch (e) {}
    if (busy) { showUpdateBanner(); return; }
    window.location.reload();
  }

  function showUpdateBanner() {
    if (document.getElementById('vlUpdateBanner')) return;
    var bar = document.createElement('div');
    bar.id = 'vlUpdateBanner';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center', 'gap:14px',
      'padding:10px 16px', 'background:#1d4ed8', 'color:#fff',
      'font:600 14px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)'
    ].join(';');
    var txt = document.createElement('span');
    txt.textContent = '🔄 Nouvelle version disponible';
    var reload = document.createElement('button');
    reload.textContent = 'Recharger maintenant';
    reload.style.cssText = 'cursor:pointer;border:0;border-radius:8px;padding:7px 14px;background:#fff;color:#1d4ed8;font-weight:700;';
    reload.addEventListener('click', function () { refreshing = true; window.location.reload(); });
    var later = document.createElement('button');
    later.textContent = 'Plus tard';
    later.style.cssText = 'cursor:pointer;border:0;border-radius:8px;padding:7px 12px;background:rgba(255,255,255,.18);color:#fff;';
    later.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(txt);
    bar.appendChild(reload);
    bar.appendChild(later);
    (document.body || document.documentElement).appendChild(bar);
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')
      .then(function (reg) {
        // Vérifie une mise à jour à l'ouverture, puis à chaque retour sur l'onglet.
        reg.update().catch(function () {});
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      })
      .catch(function (err) {
        console.warn('[VersetLive] Service Worker non enregistré :', err && err.message);
      });
  });
})();
