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
          cleanup({ thumbnail: canvas.toDataURL('image/jpeg', 0.7), duration: v.duration || 0 });
        } catch (e) {
          cleanup({ thumbnail: null, duration: v.duration || 0 });
        }
      });
      v.addEventListener('error', () => cleanup({ thumbnail: null, duration: 0 }));
      // Failsafe
      setTimeout(() => cleanup({ thumbnail: null, duration: v.duration || 0 }), 8000);
    });
  }

  // ============ Ajouter une vidéo depuis une URL ============
  async function addVideoUrl(name, url) {
    const cleaned = (url || '').trim();
    if (!cleaned) throw new Error('URL vide');
    const kind = detectUrlKind(cleaned);
    if (kind === 'youtube' || kind === 'vimeo' || kind === 'facebook' || kind === 'twitch') {
      // Ces plateformes interdisent l'incrustation dans un canvas (CORS + iframe).
      // On échoue avec un message clair plutôt que de stocker une entrée cassée.
      throw new Error(`${kind.charAt(0).toUpperCase() + kind.slice(1)} ne peut pas être incrusté dans le programme (contraintes CORS/iframe). Télécharge le fichier en MP4 et importe-le, ou utilise une URL directe vers le fichier vidéo.`);
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
    // Tentative non-bloquante d'extraire un thumbnail (échouera silencieusement si CORS bloque).
    extractUrlThumbnail(id, cleaned, kind).catch(() => {});
    return id;
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
      await saveCatalog();
      renderList();
    }
    if (v.__hlsTmp) try { v.__hlsTmp.destroy(); } catch (e) {}
  }

  // ============ Ajouter / supprimer / lister ============
  async function addVideo(name, blob, type = 'upload') {
    const id = 'v' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const { thumbnail, duration } = await extractThumbnailAndDuration(blob);
    const entry = {
      id,
      name: name || `Vidéo ${catalog.length + 1}`,
      type,
      size: blob.size,
      durationSec: duration || 0,
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
    // Cover plein cadre (ratio 16:9 target — adapte si besoin)
    const sAR = v.videoWidth / v.videoHeight;
    const dAR = W / H;
    let sx, sy, sw, sh;
    if (sAR > dAR) {
      sh = v.videoHeight;
      sw = sh * dAR;
      sx = (v.videoWidth - sw) / 2;
      sy = 0;
    } else {
      sw = v.videoWidth;
      sh = sw / dAR;
      sx = 0;
      sy = (v.videoHeight - sh) / 2;
    }
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
  }

  // ============ Hook scènes (appelé par studio.js dans setProgramScene) ============
  function onSceneChange(scene) {
    if (scene && scene.kind === 'video' && scene.videoId) {
      if (currentActiveId !== scene.videoId) startPlayback(scene.videoId);
    } else {
      if (currentActiveId) stopPlayback();
    }
  }

  function isVideoScene(scene) {
    return !!(scene && scene.kind === 'video' && scene.videoId);
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
          <div class="studio-video-meta">${fmtDuration(v.durationSec)}${v.type === 'url' ? ' · URL' : ` · ${fmtSize(v.size)}`}</div>
        </div>
        <div class="studio-video-actions">
          <button class="studio-video-action" data-act="play" title="Mettre en scène">▶</button>
          <button class="studio-video-action" data-act="loop" title="Lecture en boucle"${v.loop ? ' data-on="1"' : ''}>${v.loop ? '🔁' : '↻'}</button>
          <button class="studio-video-action" data-act="rename" title="Renommer">✎</button>
          <button class="studio-video-action" data-act="download" title="Télécharger">⬇</button>
          <button class="studio-video-action" data-act="delete" title="Supprimer">🗑</button>
        </div>
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

    // Click sur la carte = mettre en scène (en évitant les boutons d'action)
    wrap.querySelectorAll('.studio-video-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.studio-video-action')) return;
        triggerPlayScene(card.dataset.id);
      });
    });
  }

  function triggerPlayScene(id) {
    if (window.__studioApi && window.__studioApi.setScene) {
      window.__studioApi.setScene({ kind: 'video', videoId: id });
    }
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
          'Colle l\'URL d\'une vidéo (MP4, WebM, .m3u8 HLS).\n' +
          'YouTube/Vimeo/Facebook ne fonctionnent pas (limitations CORS).'
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
    draw,
    onSceneChange,
    isVideoScene,
    listScenes() {
      // Pour buildSceneList dans studio.js
      return catalog.map(v => ({
        key: `vid-${v.id}`,
        label: `${v.type === 'recording' ? '🔴' : '🎥'} ${v.name}`,
        scene: { kind: 'video', videoId: v.id }
      }));
    },
    getEntry,
    stopPlayback
  };
})();
