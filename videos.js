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

  // ============ État ============
  // catalog : array de { id, name, type: 'upload'|'recording', size, durationSec, createdAt, thumbnail (data URL), loop }
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
    catalog = catalog.filter(e => e.id !== id);
    await saveCatalog();
    await idbDel(STORE_BLOB, id);
    const cached = elemCache.get(id);
    if (cached) {
      try { cached.videoEl.pause(); } catch (e) {}
      URL.revokeObjectURL(cached.url);
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
    const blob = await idbGet(STORE_BLOB, id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    const videoEl = document.createElement('video');
    videoEl.src = url;
    videoEl.muted = false;       // audio de la vidéo va dans le mix
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    const entry = getEntry(id);
    videoEl.loop = !!(entry && entry.loop);
    elemCache.set(id, { videoEl, url });
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
      const badge = v.type === 'recording' ? '<span class="studio-video-badge rec">REC</span>' : '<span class="studio-video-badge up">⬆</span>';
      card.innerHTML = `
        ${thumb}
        <div class="studio-video-info">
          <div class="studio-video-name" title="${escapeHtml(v.name)}">${badge}${escapeHtml(v.name)}</div>
          <div class="studio-video-meta">${fmtDuration(v.durationSec)} · ${fmtSize(v.size)}</div>
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
          const blob = await idbGet(STORE_BLOB, id);
          if (!blob) return;
          const entry = getEntry(id);
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
