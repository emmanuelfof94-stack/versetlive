// Vidéothèque pour VersetLive
// - Bibliothèque de vidéos importées (MP4/WebM) + historique des enregistrements
// - Chaque vidéo devient une scène cliquable dans le studio
// - Lecture une fois puis retour automatique à la scène précédente
// Stockage : IndexedDB local (pas uploadé sur Vercel)

(function () {
  'use strict';

  const DB_NAME = 'versetlive-videolib';
  const STORE_BLOB = 'blobs';
  const STORE_META = 'meta';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_BLOB)) db.createObjectStore(STORE_BLOB);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbGet(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPut(store, key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDel(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============ Détection / chargement HLS pour URLs ============
  function detectUrlKind(url) {
    const u = (url || '').trim().toLowerCase();
    if (!u) return 'invalid';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (u.includes('vimeo.com')) return 'vimeo';
    if (u.includes('facebook.com/') || u.includes('fb.watch')) return 'facebook';
    if (u.includes('twitch.tv')) return 'twitch';
    if (/\.m3u8(\?|$)/.test(u)) return 'hls';
    if (/\.(mp4|webm|mov|m4v|ogv|ogg)(\?|$)/.test(u)) return 'direct';
    // URL générique inconnue : on tentera en direct, mais on prévient l'utilisateur.
    return 'direct';
  }

  let hlsLoaderPromise = null;
  function ensureHls() {
    if (window.Hls) return Promise.resolve();
    if (hlsLoaderPromise) return hlsLoaderPromise;
    hlsLoaderPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Impossible de charger hls.js'));
      document.head.appendChild(s);
    });
    return hlsLoaderPromise;
  }

  // ============ État ============
  // catalog : array de { id, name, type: 'upload'|'recording'|'url', size, durationSec, createdAt, thumbnail (data URL), loop, url?, urlKind? }
  let catalog = [];

  // Cache des HTMLVideoElement (un par vidéo en cache, lazy)
  const elemCache = new Map(); // id → { videoEl, url }

  // Callback fourni par studio.js pour basculer en fin de lecture
  let onVideoEnded = () => {};

  let currentActiveId = null;
  let activeEndedHandler = null;

  async function loadCatalog() {
    const data = await idbGet(STORE_META, 'catalog');
    catalog = Array.isArray(data) ? data : [];
    catalog.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function saveCatalog() {
    await idbPut(STORE_META, 'catalog', catalog);
  }

  // ============ Thumbnail + durée ============
  function extractThumbnailAndDuration(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      let resolved = false;
      const cleanup = (data) => {
        if (resolved) return;
        resolved = true;
        URL.revokeObjectURL(url);
        resolve(data);
      };
      v.addEventListener('loadedmetadata', () => {
        // Avancer à 1s pour avoir une frame plus représentative
        try { v.currentTime = Math.min(1, (v.duration || 0) / 4); } catch (e) {}
      });
      v.addEventListener('seeked', () => {
        try {
          const canvas = document.createElement('canvas');
          const W = 320;
          const ratio = (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9;
          canvas.width = W;
          canvas.height = Math.round(W / ratio);
          const c = canvas.getContext('2d');
          c.drawImage(v, 0, 0, canvas.width, canvas.height);
          cleanup({ thumbnail: canvas.toDataURL('image/jpeg', 0.7), duration: v.duration || 0, width: v.videoWidth || 0, height: v.videoHeight || 0 });
        } catch (e) {
          cleanup({ thumbnail: null, duration: v.duration || 0, width: v.videoWidth || 0, height: v.videoHeight || 0 });
        }
      });
      v.addEventListener('error', () => cleanup({ thumbnail: null, duration: 0, width: 0, height: 0 }));
      // Failsafe
      setTimeout(() => cleanup({ thumbnail: null, duration: v.duration || 0, width: v.videoWidth || 0, height: v.videoHeight || 0 }), 8000);
    });
  }

  // ============ Conversion URL -> embed (YouTube/Vimeo) ============
  function ytEmbedUrl(url) {
    try {
      const u = new URL(url);
      let id = '';
      if (u.hostname.includes('youtu.be')) id = u.pathname.slice(1);
      else if (u.hostname.includes('youtube.com')) {
        id = u.searchParams.get('v') || u.pathname.replace(/^\/(embed|shorts|live)\//, '').split('/')[0];
      }
      if (!id) return null;
      return `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
    } catch (e) { return null; }
  }
  function vimeoEmbedUrl(url) {
    try {
      const u = new URL(url);
      const id = u.pathname.split('/').filter(Boolean).pop();
      if (!id || !/^\d+$/.test(id)) return null;
      return `https://player.vimeo.com/video/${id}?autoplay=1`;
    } catch (e) { return null; }
  }

  // ============ Ajouter une vidéo depuis une URL ============
  async function addVideoUrl(name, url) {
    const cleaned = (url || '').trim();
    if (!cleaned) throw new Error('URL vide');
    const kind = detectUrlKind(cleaned);

    // YouTube / Vimeo : mode iframe (projeté sur la fenêtre projecteur,
    // pas mixé dans le canvas, donc absent du live RTMP).
    let embedUrl = null;
    if (kind === 'youtube') {
      embedUrl = ytEmbedUrl(cleaned);
      if (!embedUrl) throw new Error('Lien YouTube invalide');
    } else if (kind === 'vimeo') {
      embedUrl = vimeoEmbedUrl(cleaned);
      if (!embedUrl) throw new Error('Lien Vimeo invalide');
    } else if (kind === 'facebook' || kind === 'twitch') {
      throw new Error(`${kind === 'facebook' ? 'Facebook' : 'Twitch'} n'est pas encore supporté (les embeds nécessitent une configuration spécifique).`);
    }
    if (kind === 'invalid') throw new Error('URL invalide');

    if (kind === 'hls') {
      try { await ensureHls(); } catch (e) { /* on tentera quand même en natif Safari */ }
    }

    const id = 'v' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const entry = {
      id,
      name: name || cleaned.split('/').pop()?.split('?')[0] || `Vidéo URL ${catalog.length + 1}`,
      type: 'url',
      urlKind: kind,
      url: cleaned,
      embedUrl,                       // défini pour youtube/vimeo
      size: 0,
      durationSec: 0,
      createdAt: Date.now(),
      thumbnail: null,
      loop: false
    };
    catalog.unshift(entry);
    await saveCatalog();
    renderList();
    notifyChange();
    // Tentative non-bloquante d'extraire un thumbnail (uniquement pour URL canvas).
    if (kind === 'direct' || kind === 'hls') {
      extractUrlThumbnail(id, cleaned, kind).catch(() => {});
    }
    return id;
  }

  function isIframeKind(kind) {
    return kind === 'youtube' || kind === 'vimeo';
  }

  async function extractUrlThumbnail(id, url, kind) {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    if (kind === 'hls' && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      hls.loadSource(url);
      hls.attachMedia(v);
      v.__hlsTmp = hls;
    } else {
      v.src = url;
    }
    await new Promise((resolve, reject) => {
      v.addEventListener('loadeddata', resolve, { once: true });
      v.addEventListener('error', () => reject(new Error('load failed')), { once: true });
      setTimeout(() => reject(new Error('timeout')), 8000);
    });
    try { v.currentTime = Math.min(2, (v.duration || 4) / 2); } catch (e) {}
    await new Promise(r => v.addEventListener('seeked', r, { once: true }));
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const cctx = c.getContext('2d');
    cctx.drawImage(v, 0, 0, c.width, c.height);
    let thumb = null;
    try { thumb = c.toDataURL('image/jpeg', 0.7); } catch (e) {}
    const entry = catalog.find(e => e.id === id);
    if (entry) {
      if (thumb) entry.thumbnail = thumb;
      if (v.duration && isFinite(v.duration)) entry.durationSec = v.duration;
      if (v.videoWidth) entry.width = v.videoWidth;
      if (v.videoHeight) entry.height = v.videoHeight;
      await saveCatalog();
      renderList();
    }
    if (v.__hlsTmp) try { v.__hlsTmp.destroy(); } catch (e) {}
  }

  // ============ Ajouter / supprimer / lister ============
  async function addVideo(name, blob, type = 'upload') {
    const id = 'v' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const { thumbnail, duration, width, height } = await extractThumbnailAndDuration(blob);
    const entry = {
      id,
      name: name || `Vidéo ${catalog.length + 1}`,
      type,
      size: blob.size,
      durationSec: duration || 0,
      width: width || 0,
      height: height || 0,
      createdAt: Date.now(),
      thumbnail,
      loop: false
    };
    await idbPut(STORE_BLOB, id, blob);
    catalog.unshift(entry);
    await saveCatalog();
    renderList();
    notifyChange();
    return id;
  }

  async function removeVideo(id) {
    const entry = catalog.find(e => e.id === id);
    catalog = catalog.filter(e => e.id !== id);
    await saveCatalog();
    if (entry && entry.type !== 'url') await idbDel(STORE_BLOB, id);
    const cached = elemCache.get(id);
    if (cached) {
      try { cached.videoEl.pause(); } catch (e) {}
      if (cached.hls) { try { cached.hls.destroy(); } catch (e) {} }
      if (entry && entry.type !== 'url') URL.revokeObjectURL(cached.url);
      elemCache.delete(id);
    }
    renderList();
    notifyChange();
    // Si la scène active était celle-ci, retour à noir
    if (currentActiveId === id) {
      currentActiveId = null;
      onVideoEnded();
    }
  }

  async function renameVideo(id, newName) {
    const e = catalog.find(x => x.id === id);
    if (!e) return;
    e.name = newName;
    await saveCatalog();
    renderList();
    notifyChange();
  }

  async function setLoop(id, loop) {
    const e = catalog.find(x => x.id === id);
    if (!e) return;
    e.loop = !!loop;
    await saveCatalog();
    const cached = elemCache.get(id);
    if (cached) cached.videoEl.loop = !!loop;
    renderList();
  }

  function getEntry(id) {
    return catalog.find(e => e.id === id);
  }

  async function getVideoElement(id) {
    let cached = elemCache.get(id);
    if (cached) return cached.videoEl;
    const entry = getEntry(id);
    if (!entry) return null;

    const videoEl = document.createElement('video');
    videoEl.muted = false;        // audio de la vidéo va dans le mix
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    videoEl.loop = !!entry.loop;
    // crossOrigin nécessaire pour dessiner dans le canvas sans tainting.
    // Si le serveur ne renvoie pas CORS, la lecture échouera et on tombera
    // sur le fallback sans crossOrigin (lecture visible mais canvas tainted).
    videoEl.crossOrigin = 'anonymous';

    let cacheUrl = null;
    let hlsInstance = null;

    if (entry.type === 'url') {
      const url = entry.url;
      if (entry.urlKind === 'hls') {
        if (window.Hls && window.Hls.isSupported()) {
          hlsInstance = new window.Hls();
          hlsInstance.loadSource(url);
          hlsInstance.attachMedia(videoEl);
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = url; // Safari supporte HLS nativement
        } else {
          // Dernier recours
          videoEl.src = url;
        }
      } else {
        videoEl.src = url;
      }
      cacheUrl = url;
      // Filet de sécurité CORS : si l'attribut crossOrigin bloque le chargement,
      // on réessaie sans (la lecture marche mais le canvas sera tainted → projection noire).
      videoEl.addEventListener('error', () => {
        if (videoEl.crossOrigin) {
          videoEl.removeAttribute('crossorigin');
          if (!hlsInstance) { videoEl.src = url; videoEl.load(); }
        }
      }, { once: true });
    } else {
      const blob = await idbGet(STORE_BLOB, id);
      if (!blob) return null;
      cacheUrl = URL.createObjectURL(blob);
      videoEl.src = cacheUrl;
    }

    elemCache.set(id, { videoEl, url: cacheUrl, hls: hlsInstance });
    return videoEl;
  }

  // ============ Lecture (appelé par studio.js depuis onSceneChange) ============
  async function startPlayback(id) {
    // Arrêter une éventuelle lecture précédente
    stopPlayback();

    const videoEl = await getVideoElement(id);
    if (!videoEl) {
      // Vidéo manquante (supprimée ?) → retour scène précédente
      onVideoEnded();
      return;
    }
    currentActiveId = id;
    activeEndedHandler = () => {
      if (currentActiveId !== id) return;
      const entry = getEntry(id);
      if (entry && entry.loop) {
        // En loop, on ne quitte pas la scène
        return;
      }
      currentActiveId = null;
      activeEndedHandler = null;
      onVideoEnded();
    };
    videoEl.addEventListener('ended', activeEndedHandler);
    // Restaure l'état audio/boucle au cas où la vidéo aurait servi en mosaïque
    // (où elle est forcée en muet + boucle).
    videoEl.muted = false;
    videoEl.loop = !!(getEntry(id) && getEntry(id).loop);
    try { videoEl.currentTime = 0; } catch (e) {}
    videoEl.play().catch(err => console.warn('video play blocked', err));

    // Brancher l'audio dans programAudioStream du studio (si disponible)
    routeAudio(id, videoEl);
  }

  function stopPlayback() {
    if (currentActiveId) {
      const cached = elemCache.get(currentActiveId);
      if (cached) {
        try { cached.videoEl.pause(); } catch (e) {}
        try { cached.videoEl.currentTime = 0; } catch (e) {}
        if (activeEndedHandler) {
          try { cached.videoEl.removeEventListener('ended', activeEndedHandler); } catch (e) {}
        }
      }
      unrouteAudio(currentActiveId);
    }
    currentActiveId = null;
    activeEndedHandler = null;
  }

  // ============ Audio mixing dans programAudioStream ============
  const audioRoutes = new Map(); // id → { source, gain }

  function routeAudio(id, videoEl) {
    const ctxAudio = window.__studioAudio?.audioCtx;
    const dest = window.__studioAudio?.audioDest;
    if (!ctxAudio || !dest) return;
    try {
      // Si déjà routé une fois pour cet élément, ne pas recréer (sinon InvalidStateError)
      if (audioRoutes.has(id)) {
        const r = audioRoutes.get(id);
        r.source.connect(r.gain);
        r.gain.connect(dest);
        r.gain.connect(ctxAudio.destination);
        return;
      }
      const src = ctxAudio.createMediaElementSource(videoEl);
      const gain = ctxAudio.createGain();
      gain.gain.value = 1.0;
      src.connect(gain);
      gain.connect(dest);                  // dans le mix programme (donc enregistrement + stream)
      gain.connect(ctxAudio.destination);  // monitoring Mac
      audioRoutes.set(id, { source: src, gain });
    } catch (e) {
      console.warn('routeAudio video failed', e);
    }
  }

  function unrouteAudio(id) {
    const r = audioRoutes.get(id);
    if (!r) return;
    try { r.gain.disconnect(); } catch (e) {}
    try { r.source.disconnect(); } catch (e) {}
    // Garder dans audioRoutes pour permettre reconnect (createMediaElementSource ne peut être appelé qu'une fois)
  }

  // ============ Dessin ============
  function draw(ctx, id, W, H) {
    const cached = elemCache.get(id);
    if (!cached) {
      // Si pas encore prête → fond noir + nom
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const entry = getEntry(id);
      if (entry) {
        ctx.fillStyle = '#666';
        ctx.font = `${Math.round(H * 0.04)}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`Chargement de « ${entry.name} »…`, W / 2, H / 2);
      }
      return;
    }
    const v = cached.videoEl;
    if (!v.videoWidth) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    // Backfill de la résolution native pour les vidéos importées avant que
    // celle-ci ne soit stockée (lue une seule fois, dès qu'elle est connue).
    const entry0 = getEntry(id);
    if (entry0 && !entry0.width && v.videoWidth) {
      entry0.width = v.videoWidth;
      entry0.height = v.videoHeight;
      saveCatalog().then(() => renderList()).catch(() => {});
    }
    // Cadrage réglable par vidéo (largeur/hauteur + garder les proportions).
    // Le cadre où la vidéo est dessinée fait fitW × fitH de l'écran, centré.
    //  - garder les proportions (par défaut) : la vidéo tient entière dans ce
    //    cadre sans déformation, bandes bleu nuit autour → rien n'est rogné ;
    //  - sinon : la vidéo est étirée pour remplir tout le cadre (déformation ok).
    // Défaut (1, 1, proportions) = vidéo entière plein écran, sans rognage.
    const fit = getFit(id);
    const boxW = W * fit.w;
    const boxH = H * fit.h;
    const boxX = (W - boxW) / 2 + fit.offX * W;
    const boxY = (H - boxH) / 2 + fit.offY * H;

    // Fond letterbox (couleur projecteur) sur toute la zone hors vidéo.
    ctx.fillStyle = '#131536';
    ctx.fillRect(0, 0, W, H);

    if (fit.keepAspect) {
      const scale = Math.min(boxW / v.videoWidth, boxH / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight,
        boxX + (boxW - dw) / 2, boxY + (boxH - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight, boxX, boxY, boxW, boxH);
    }
  }

  // Réglages de cadrage par vidéo, avec valeurs par défaut sûres.
  function getFit(id) {
    const e = getEntry(id);
    const w = e && e.fitW != null ? Math.max(0.1, Math.min(1, e.fitW)) : 1;
    const h = e && e.fitH != null ? Math.max(0.1, Math.min(1, e.fitH)) : 1;
    const keepAspect = e && e.fitKeepAspect != null ? !!e.fitKeepAspect : true;
    // Décalage (position) de la vidéo dans l'écran : fraction -0.5..0.5.
    const offX = e && e.fitOffsetX != null ? Math.max(-0.5, Math.min(0.5, e.fitOffsetX)) : 0;
    const offY = e && e.fitOffsetY != null ? Math.max(-0.5, Math.min(0.5, e.fitOffsetY)) : 0;
    return { w, h, keepAspect, offX, offY };
  }

  async function setFit(id, patch) {
    const e = catalog.find(x => x.id === id);
    if (!e) return;
    if (patch.w != null) e.fitW = Math.max(0.1, Math.min(1, patch.w));
    if (patch.h != null) e.fitH = Math.max(0.1, Math.min(1, patch.h));
    if (patch.keepAspect != null) e.fitKeepAspect = !!patch.keepAspect;
    if (patch.offX != null) e.fitOffsetX = Math.max(-0.5, Math.min(0.5, patch.offX));
    if (patch.offY != null) e.fitOffsetY = Math.max(-0.5, Math.min(0.5, patch.offY));
    await saveCatalog();
  }

  // ============ Lecture mosaïque (plusieurs vidéos en aperçu, muettes) ============
  // En mosaïque, les vidéos doivent rester animées dans leurs cellules, mais
  // sans audio (sinon toutes joueraient en même temps) et sans toucher au
  // modèle « scène active » (currentActiveId) ni au routage audio du programme.
  const mosaicEls = new Set(); // ids forcés en lecture muette pour la mosaïque

  async function startMosaicVideos(ids) {
    const keep = new Set(ids);
    // Arrête ceux qui ne font plus partie de la mosaïque.
    for (const id of [...mosaicEls]) {
      if (!keep.has(id)) releaseMosaicVideo(id);
    }
    // Démarre / maintient ceux de la mosaïque.
    for (const id of ids) {
      if (id === currentActiveId) continue; // déjà géré par la lecture normale
      const el = await getVideoElement(id);
      if (!el) continue;
      el.muted = true;   // aperçu visuel uniquement
      el.loop = true;    // boucle pour rester animé
      try { el.play().catch(() => {}); } catch (e) {}
      mosaicEls.add(id);
    }
  }

  function releaseMosaicVideo(id) {
    mosaicEls.delete(id);
    if (id === currentActiveId) return; // ne pas perturber la scène active
    const cached = elemCache.get(id);
    if (cached) {
      try { cached.videoEl.pause(); } catch (e) {}
      cached.videoEl.loop = !!(getEntry(id) && getEntry(id).loop);
    }
  }

  function stopMosaicVideos() {
    for (const id of [...mosaicEls]) releaseMosaicVideo(id);
  }

  // ============ Hook scènes (appelé par studio.js dans setProgramScene) ============
  function onSceneChange(scene) {
    if (scene && (scene.kind === 'video' || scene.kind === 'video+verse') && scene.videoId) {
      stopMosaicVideos();
      if (currentActiveId !== scene.videoId) startPlayback(scene.videoId);
    } else if (scene && scene.kind === 'mosaic') {
      if (currentActiveId) stopPlayback();
      const ids = (scene.items || [])
        .filter(it => it && (it.kind === 'video' || it.kind === 'video+verse') && it.videoId)
        .map(it => it.videoId);
      startMosaicVideos(ids);
    } else {
      stopMosaicVideos();
      if (currentActiveId) stopPlayback();
    }
  }

  function isVideoScene(scene) {
    return !!(scene && (scene.kind === 'video' || scene.kind === 'video+verse') && scene.videoId);
  }

  // ============ UI ============
  function $(id) { return document.getElementById(id); }

  function fmtDuration(sec) {
    if (!sec || !isFinite(sec)) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' o';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' Ko';
    return (bytes / 1024 / 1024).toFixed(1) + ' Mo';
  }

  function renderList() {
    const wrap = $('videosList');
    if (!wrap) return;
    if (!catalog.length) {
      wrap.innerHTML = '<div class="studio-empty">Aucune vidéo. Importe un MP4 ou démarre un enregistrement.</div>';
      return;
    }
    wrap.innerHTML = '';
    catalog.forEach(v => {
      const card = document.createElement('div');
      card.className = 'studio-video-card';
      card.dataset.id = v.id;
      const thumb = v.thumbnail
        ? `<img class="studio-video-thumb" src="${v.thumbnail}" alt="">`
        : '<div class="studio-video-thumb studio-video-thumb-placeholder">🎞</div>';
      const badge = v.type === 'recording'
        ? '<span class="studio-video-badge rec">REC</span>'
        : v.type === 'url'
          ? '<span class="studio-video-badge up" title="Vidéo depuis URL">🔗</span>'
          : '<span class="studio-video-badge up">⬆</span>';
      card.innerHTML = `
        ${thumb}
        <div class="studio-video-info">
          <div class="studio-video-name" title="${escapeHtml(v.name)}">${badge}${escapeHtml(v.name)}</div>
          <div class="studio-video-meta">${fmtDuration(v.durationSec)}${v.type === 'url' ? ' · URL' : ` · ${fmtSize(v.size)}`}${(v.width && v.height) ? ` · ${v.width}×${v.height}` : ''}</div>
        </div>
        <div class="studio-video-actions">
          <button class="studio-video-action" data-act="play" title="Mettre en scène">▶</button>
          <button class="studio-video-action" data-act="loop" title="Lecture en boucle"${v.loop ? ' data-on="1"' : ''}>${v.loop ? '🔁' : '↻'}</button>
          <button class="studio-video-action" data-act="fit" title="Cadrage (largeur / hauteur)">⤢</button>
          <button class="studio-video-action" data-act="rename" title="Renommer">✎</button>
          <button class="studio-video-action" data-act="download" title="Télécharger">⬇</button>
          <button class="studio-video-action" data-act="delete" title="Supprimer">🗑</button>
        </div>
        <div class="studio-video-fit" hidden></div>
      `;
      wrap.appendChild(card);
    });

    // Délégation des actions
    wrap.querySelectorAll('.studio-video-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.closest('.studio-video-card').dataset.id;
        const act = btn.dataset.act;
        if (act === 'play') triggerPlayScene(id);
        else if (act === 'loop') {
          const entry = getEntry(id);
          if (entry) await setLoop(id, !entry.loop);
        }
        else if (act === 'fit') {
          const card = btn.closest('.studio-video-card');
          const panel = card.querySelector('.studio-video-fit');
          if (!panel) return;
          panel.hidden = !panel.hidden;
          btn.classList.toggle('on', !panel.hidden);
          if (!panel.hidden) renderFitPanel(panel, id);
        }
        else if (act === 'rename') {
          const entry = getEntry(id);
          if (entry) {
            const newName = prompt('Nouveau nom :', entry.name);
            if (newName && newName.trim()) await renameVideo(id, newName.trim());
          }
        }
        else if (act === 'download') {
          const entry = getEntry(id);
          if (entry?.type === 'url') {
            // Pour une vidéo URL, on ouvre simplement le lien dans un nouvel onglet.
            window.open(entry.url, '_blank');
            return;
          }
          const blob = await idbGet(STORE_BLOB, id);
          if (!blob) return;
          const a = document.createElement('a');
          const url = URL.createObjectURL(blob);
          a.href = url;
          a.download = (entry?.name || 'video') + (blob.type.includes('mp4') ? '.mp4' : '.webm');
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        }
        else if (act === 'delete') {
          const entry = getEntry(id);
          if (confirm(`Supprimer « ${entry?.name || 'cette vidéo'} » ? Cette action est définitive.`)) {
            await removeVideo(id);
          }
        }
      });
    });

    // Click sur la carte = mettre en scène (en évitant les boutons d'action
    // et le panneau de cadrage déplié)
    wrap.querySelectorAll('.studio-video-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.studio-video-action')) return;
        if (e.target.closest('.studio-video-fit')) return;
        triggerPlayScene(card.dataset.id);
      });
    });
  }

  // Panneau de cadrage par vidéo : largeur, hauteur, garder les proportions.
  // Les réglages s'appliquent en direct (draw() relit getFit() à chaque frame).
  // Écran de référence pour la taille affichée en pixels (projecteur 16:9 1080p).
  const SCREEN_W = 1920, SCREEN_H = 1080;

  function renderFitPanel(panel, id) {
    const fit = getFit(id);
    const entry = getEntry(id);
    const wPct = Math.round(fit.w * 100);
    const hPct = Math.round(fit.h * 100);
    const xPct = Math.round(fit.offX * 100);
    const yPct = Math.round(fit.offY * 100);
    const srcLabel = (entry && entry.width && entry.height)
      ? `${entry.width}×${entry.height} px`
      : 'résolution inconnue';
    const screenPx = (wp, hp) => `${Math.round(wp / 100 * SCREEN_W)} × ${Math.round(hp / 100 * SCREEN_H)} px`;
    panel.innerHTML = `
      <div class="studio-video-fit-src">Source : <b>${srcLabel}</b> · écran ${SCREEN_W}×${SCREEN_H}</div>
      <div class="studio-video-fit-row">
        <label>Largeur</label>
        <input type="range" data-fit="w" min="10" max="100" step="1" value="${wPct}">
        <span class="studio-video-fit-val" data-fit-val="w">${wPct} %</span>
      </div>
      <div class="studio-video-fit-row">
        <label>Hauteur</label>
        <input type="range" data-fit="h" min="10" max="100" step="1" value="${hPct}">
        <span class="studio-video-fit-val" data-fit-val="h">${hPct} %</span>
      </div>
      <div class="studio-video-fit-row">
        <label>Position ↔</label>
        <input type="range" data-fit="x" min="-50" max="50" step="1" value="${xPct}">
        <span class="studio-video-fit-val" data-fit-val="x">${xPct} %</span>
      </div>
      <div class="studio-video-fit-row">
        <label>Position ↕</label>
        <input type="range" data-fit="y" min="-50" max="50" step="1" value="${yPct}">
        <span class="studio-video-fit-val" data-fit-val="y">${yPct} %</span>
      </div>
      <div class="studio-video-fit-screen">À l'écran : <b data-fit-screen>${screenPx(wPct, hPct)}</b></div>
      <label class="studio-video-fit-keep">
        <input type="checkbox" data-fit="keepAspect" ${fit.keepAspect ? 'checked' : ''}>
        Garder les proportions (pas de déformation)
      </label>
      <button class="studio-video-fit-reset" type="button">Réinitialiser</button>
    `;

    const screenEl = panel.querySelector('[data-fit-screen]');
    const updateScreen = () => {
      const wv = parseInt(panel.querySelector('[data-fit="w"]').value, 10);
      const hv = parseInt(panel.querySelector('[data-fit="h"]').value, 10);
      if (screenEl) screenEl.textContent = screenPx(wv, hv);
    };

    panel.querySelectorAll('input[type="range"]').forEach(slider => {
      slider.addEventListener('input', (e) => {
        e.stopPropagation();
        const key = slider.dataset.fit;
        const val = parseInt(slider.value, 10);
        // w/h → fraction de taille ; x/y → fraction de décalage (offX/offY).
        if (key === 'x') setFit(id, { offX: val / 100 });
        else if (key === 'y') setFit(id, { offY: val / 100 });
        else setFit(id, { [key]: val / 100 });
        const valEl = panel.querySelector(`[data-fit-val="${key}"]`);
        if (valEl) valEl.textContent = val + ' %';
        updateScreen();
      });
    });

    const keep = panel.querySelector('input[type="checkbox"]');
    if (keep) keep.addEventListener('change', (e) => {
      e.stopPropagation();
      setFit(id, { keepAspect: keep.checked });
    });

    const reset = panel.querySelector('.studio-video-fit-reset');
    if (reset) reset.addEventListener('click', (e) => {
      e.stopPropagation();
      setFit(id, { w: 1, h: 1, keepAspect: true, offX: 0, offY: 0 });
      renderFitPanel(panel, id);
    });
  }

  function triggerPlayScene(id) {
    if (!window.__studioApi || !window.__studioApi.setScene) return;
    const entry = getEntry(id);
    if (entry && entry.type === 'url' && isIframeKind(entry.urlKind) && entry.embedUrl) {
      // Mode iframe : la vidéo joue dans la fenêtre projecteur, pas dans le canvas.
      window.__studioApi.setScene({
        kind: 'iframe',
        url: entry.embedUrl,
        label: entry.name,
        videoId: id
      });
      return;
    }
    window.__studioApi.setScene({ kind: 'video', videoId: id });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function bindUi() {
    const fileInput = $('videoUploadInput');
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const f of files) {
          await addVideo(f.name.replace(/\.[^.]+$/, ''), f, 'upload');
        }
        fileInput.value = '';
      });
    }
    const urlBtn = $('addVideoUrlBtn');
    if (urlBtn) {
      urlBtn.addEventListener('click', async () => {
        const url = prompt(
          'Colle l\'URL d\'une vidéo :\n' +
          '• MP4/WebM/HLS → lecture mixée (projection + live RTMP)\n' +
          '• YouTube/Vimeo → projection seulement (pas dans le live)\n' +
          '• Facebook/Twitch : non supportés'
        );
        if (!url) return;
        const name = prompt('Nom à afficher pour cette vidéo (optionnel) :', '');
        try {
          await addVideoUrl(name, url);
        } catch (e) {
          alert('Impossible d\'ajouter cette URL : ' + (e.message || e));
        }
      });
    }
  }

  // ============ onChange (signale au studio que la liste/scènes ont changé) ============
  let onChange = () => {};
  function notifyChange() { onChange(); }

  // ============ API publique ============
  window.VideoLibrary = {
    async init(opts) {
      onChange = opts?.onChange || (() => {});
      onVideoEnded = opts?.onVideoEnded || (() => {});
      bindUi();
      await loadCatalog();
      renderList();
    },
    async addRecording(blob, suggestedName) {
      const name = suggestedName || `Enregistrement ${new Date().toLocaleString('fr-FR')}`;
      await addVideo(name, blob, 'recording');
    },
    // Ajout d'une vidéo par lien (YouTube, Vimeo, .mp4, HLS…). Utilisé aussi par
    // la coop : un copilote envoie une URL, le host l'ajoute ici. Throw si invalide.
    addVideoUrl,
    draw,
    onSceneChange,
    isVideoScene,
    listScenes() {
      // Pour buildSceneList dans studio.js
      const out = [];
      catalog.forEach(v => {
        const isIframe = v.type === 'url' && isIframeKind(v.urlKind) && v.embedUrl;
        const icon = v.type === 'recording' ? '🔴' : v.type === 'url' && isIframeKind(v.urlKind) ? '🌐' : v.type === 'url' ? '🔗' : '🎥';
        out.push({
          key: `vid-${v.id}`,
          label: `${icon} ${v.name}`,
          scene: isIframe
            ? { kind: 'iframe', url: v.embedUrl, label: v.name, videoId: v.id }
            : { kind: 'video', videoId: v.id }
        });
        // Variante « + verset » : seulement pour les vidéos lues sur le canvas
        // (pas les iframes externes, dont le verset ne pourrait pas être incrusté).
        if (!isIframe) {
          out.push({
            key: `vid-verse-${v.id}`,
            label: `${icon} ${v.name} + verset`,
            scene: { kind: 'video+verse', videoId: v.id }
          });
        }
      });
      return out;
    },
    getEntry,
    stopPlayback
  };
})();
