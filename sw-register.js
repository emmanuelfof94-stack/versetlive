// VersetLive — Enregistrement du Service Worker (hors-ligne + cache logos)
// Inclus depuis index.html, studio.html, obs.html, tv.html, studio-output.html.
// Pas d'enregistrement si navigateur sans support ou si on est sur localhost
// en mode incognito (le SW peut planter dans certains contextes restrictifs).
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')
      .then(function (reg) {
        // Vérifie une mise à jour disponible à chaque ouverture (silencieux).
        reg.update().catch(function () {});
      })
      .catch(function (err) {
        console.warn('[VersetLive] Service Worker non enregistré :', err && err.message);
      });
  });
})();
