// Studio VersetLive — Phase 1
// Mixeur multi-caméras USB, sortie projecteur, enregistrement local.
// Partage l'état du verset avec index.html via BroadcastChannel + localStorage.

const CHANNEL_NAME = 'versetlive';
const STORAGE_KEY = 'versetlive:state';
const QUALITY_KEY = 'versetlive:studio:quality';

// Qualité dynamique — modifiable au runtime via le sélecteur de la topbar.
// OUTPUT_W/H/FPS restent mutables (et non const) pour que toutes les fonctions
// qui les référencent voient automatiquement la nouvelle résolution après bascule.
const QUALITY_PRESETS = {
  '720p':  { w: 1280, h: 720,  streamBitrate: 2_500_000, recordBitrate: 4_000_000 },
  '1080p': { w: 1920, h: 1080, streamBitrate: 4_500_000, recordBitrate: 6_000_000 },
};
let currentQuality = (localStorage.getItem(QUALITY_KEY) === '1080p') ? '1080p' : '720p';
let OUTPUT_W = QUALITY_PRESETS[currentQuality].w;
let OUTPUT_H = QUALITY_PRESETS[currentQuality].h;
const OUTPUT_FPS = 30;

// ============ Réglages performance (anti-saccades projecteur) ============
const SMOOTH_PRIORITY_KEY = 'versetlive:smooth-priority';
const AUTO_RES_KEY = 'versetlive:auto-res';
const PERF_HUD_KEY = 'versetlive:perf-hud';
// Priorité fluidité : sous charge d'encodeurs, allège le rendu non essentiel
// (aperçu/multiview) pour que le programme — donc le projecteur — reste à 30 fps.
let smoothPriorityOn = localStorage.getItem(SMOOTH_PRIORITY_KEY) !== '0';
// Baisse auto de résolution sous charge (opt-in) : voir maybeAutoResolution().
let autoResOn = localStorage.getItem(AUTO_RES_KEY) === '1';
let perfHudOn = localStorage.getItem(PERF_HUD_KEY) === '1';

// ============ État ============
const sources = []; // [{ id, deviceId, label, stream, videoEl, muted, audioEnabled }]
let micStream = null;
let micDeviceId = '';
let audioCtx = null;
let audioDest = null; // MediaStreamAudioDestinationNode
let micGainNode = null;
let micAnalyser = null;
let programStream = null;
let programAudioStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let outputWindow = null;
let nextSourceId = 1;

// Sources image (logo, photo prédicateur, annonces...)
const imageSources = []; // [{ id, name, dataUrl, imgEl }]
let nextImageId = 1;
// Taille des images plein écran (scènes 🖼 image / image+verset), 0.1..1 = part de l'écran.
const FULL_IMAGE_SCALE_KEY = 'versetlive:full-image-scale';
let fullImageScale = (() => {
  const v = parseFloat(localStorage.getItem(FULL_IMAGE_SCALE_KEY));
  return (v >= 0.1 && v <= 1) ? v : 1;
})();
let logoOverlayId = null; // image id utilisée en overlay coin
let logoOverlayEnabled = false;

// Cartes pré-composées (image + texte stylé) — persistées en localStorage,
// référencent une image déjà importée par imageId.
const CARDS_KEY = 'versetlive:cards';
const cards = []; // [{ id, name, imageId, title, subtitle, vAlign, hAlign, titleSize, subtitleSize, color, shadow, bgBox }]
let nextCardId = 1;

// Scène active : { kind, primaryId?, secondaryId? }
//   kind ∈ { 'camera', 'camera+verse', 'pip', 'image', 'image+verse', 'card', 'verse', 'intro', 'outro', 'black' }
let programScene = { kind: 'black' };
let previewScene = { kind: 'black' };
let previousProgramScene = null;
let transitionStart = 0;

// Configuration transition (persistée)
const TRANSITION_KEY = 'versetlive:transition';
let transitionCfg = loadTransitionCfg();

// Bande d'annonce défilante (overlay global, persistée)
const TICKER_KEY = 'versetlive:ticker';
let tickerCfg = loadTickerCfg();
let tickerOffset = 0;   // décalage de défilement courant (px)
let tickerLastTs = 0;   // horodatage de la dernière avance (performance.now)
let tickerPaused = false; // pause manuelle du défilement (non persistée)
let tickerStarts = [];  // offset px du début de chaque annonce dans le cycle (pour préc/suiv)

// Studio Mode (Preview/Program). Off par défaut = clic scène → direct.
const STUDIO_MODE_KEY = 'versetlive:studio-mode';
let studioMode = localStorage.getItem(STUDIO_MODE_KEY) === '1';

// Filtres par source (persistés par deviceId)
const FILTERS_KEY = 'versetlive:filters';
let filtersStore = loadFiltersStore(); // { [deviceId]: { mirror, brightness, contrast, saturation } }
const openFilterPanels = new Set(); // sourceIds dont le panneau filtres est ouvert

let verseState = null;

const TRANSITION_KINDS = ['cut', 'fade', 'fade-black', 'fade-white', 'slide', 'zoom'];
function loadTransitionCfg() {
  try {
    const raw = localStorage.getItem(TRANSITION_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      const kind = TRANSITION_KINDS.includes(c.kind) ? c.kind : 'fade';
      return { kind, durationMs: Math.max(0, Math.min(1000, c.durationMs ?? 300)) };
    }
  } catch (e) {}
  return { kind: 'fade', durationMs: 300 };
}

function loadTickerCfg() {
  try {
    const raw = localStorage.getItem(TICKER_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      return {
        enabled: !!c.enabled,
        messages: Array.isArray(c.messages) ? c.messages.filter(m => typeof m === 'string') : [],
        speed: Math.max(20, Math.min(400, c.speed ?? 100)),
        fontScale: Math.max(0.5, Math.min(2.5, c.fontScale ?? 1)),
        weight: Math.max(400, Math.min(900, c.weight ?? 600)),
        posY: Math.max(0, Math.min(1, c.posY ?? 0)),
        bgColor: c.bgColor || '#0f172a',
        textColor: c.textColor || '#ffffff'
      };
    }
  } catch (e) {}
  return { enabled: false, messages: [], speed: 100, fontScale: 1, weight: 600, posY: 0, bgColor: '#0f172a', textColor: '#ffffff' };
}
function saveTickerCfg() {
  try { localStorage.setItem(TICKER_KEY, JSON.stringify(tickerCfg)); } catch (e) {}
}
function saveTransitionCfg() {
  try { localStorage.setItem(TRANSITION_KEY, JSON.stringify(transitionCfg)); } catch (e) {}
}
function loadFiltersStore() {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch (e) {}
  return {};
}
function saveFiltersStore() {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filtersStore)); } catch (e) {}
}
function defaultFilters() {
  return { mirror: false, brightness: 100, contrast: 100, saturation: 100, zoom: 100 };
}
function getFiltersFor(source) {
  const key = source.deviceId || source.id;
  if (!filtersStore[key]) filtersStore[key] = defaultFilters();
  // Migration : ajoute le champ zoom aux filtres existants enregistrés avant cette version.
  if (filtersStore[key].zoom == null) filtersStore[key].zoom = 100;
  return filtersStore[key];
}
function hasNonDefaultFilter(f) {
  return f.mirror || f.brightness !== 100 || f.contrast !== 100 || f.saturation !== 100 || (f.zoom || 100) !== 100;
}
// Sous-prédicat : faut-il invoquer ctx.filter (couleurs) ? Le zoom est appliqué
// via crop de la source — ne nécessite PAS ctx.filter. Tester ctx.filter pour rien
// déclenche un buffer off-screen côté navigateur, ce qui pourrit les perfs.
function hasColorFilter(f) {
  return f.brightness !== 100 || f.contrast !== 100 || f.saturation !== 100;
}
// Applique zoom + miroir au <video> de preview en CSS. L'inline transform écrase
// la règle .mirror du CSS, donc on combine les deux ici dès qu'un zoom est actif.
function applyPreviewZoom(videoEl, filters) {
  const z = Math.max(100, Math.min(300, filters.zoom || 100)) / 100;
  const t = [];
  if (filters.mirror) t.push('scaleX(-1)');
  if (z > 1) t.push(`scale(${z})`);
  videoEl.style.transform = t.join(' ');
  videoEl.style.transformOrigin = '50% 50%';
}

// ============ DOM ============
const $ = id => document.getElementById(id);
const programCanvas = $('programCanvas');
const ctx = programCanvas.getContext('2d', { alpha: false });
const previewCanvas = $('previewCanvas');
const previewCtx = previewCanvas.getContext('2d', { alpha: false });
// Ctx actif pour les helpers de dessin — pivoté entre program et preview à chaque frame.
let activeCtx = ctx;

// ============ Toast ============
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' err' : '');
  setTimeout(() => el.classList.remove('show'), 2400);
}

// ============ Énumération devices ============
async function refreshDeviceList() {
  // Demande au moins une permission pour que les labels soient remplis
  let permGranted = false;
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    tmp.getTracks().forEach(t => t.stop());
    permGranted = true;
  } catch (e) {
    toast('Permission caméra/micro refusée — clique sur 🔒 dans la barre d\'adresse pour autoriser.', true);
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  const mics = devices.filter(d => d.kind === 'audioinput');

  // Remplir le sélecteur caméra (en excluant celles déjà ajoutées)
  const camSel = $('cameraSelect');
  camSel.innerHTML = '';
  const usedIds = new Set(sources.map(s => s.deviceId));
  cams.filter(c => !usedIds.has(c.deviceId)).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.deviceId;
    opt.textContent = c.label || `Caméra ${c.deviceId.slice(0, 6)}`;
    camSel.appendChild(opt);
  });
  if (!camSel.options.length) {
    const opt = document.createElement('option');
    opt.textContent = cams.length ? 'Toutes les caméras sont déjà ajoutées' : 'Aucune caméra détectée';
    opt.disabled = true;
    camSel.appendChild(opt);
  }

  // Remplir le sélecteur micro
  const micSel = $('micSelect');
  const previousMic = micSel.value;
  micSel.innerHTML = '<option value="">— Pas de micro —</option>';
  mics.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.deviceId;
    opt.textContent = m.label || `Micro ${m.deviceId.slice(0, 6)}`;
    micSel.appendChild(opt);
  });
  if (previousMic) micSel.value = previousMic;
}

// ============ Ajout d'une caméra ============
async function addCamera(deviceId, label) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });

    const videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    await videoEl.play().catch(() => {});

    const source = {
      id: 's' + (nextSourceId++),
      deviceId,
      label,
      stream,
      videoEl,
      muted: false
    };
    sources.push(source);

    renderSources();
    renderScenes();
    refreshDeviceList();
    toast(`Caméra ajoutée : ${label}`);
  } catch (err) {
    toast('Impossible d\'ouvrir la caméra : ' + err.message, true);
  }
}

function removeCamera(sourceId) {
  const idx = sources.findIndex(s => s.id === sourceId);
  if (idx < 0) return;
  const s = sources[idx];
  disconnectSourceAudio(s);
  s.stream.getTracks().forEach(t => t.stop());
  sources.splice(idx, 1);

  // Si la scène utilise cette caméra, basculer
  if (programScene.primaryId === sourceId || programScene.secondaryId === sourceId) {
    setScene(sources.length ? { kind: 'camera', primaryId: sources[0].id } : { kind: 'black' });
  }
  renderSources();
  renderScenes();
  refreshDeviceList();
}

// ============ Rendu UI des sources ============
function renderSources() {
  if (typeof coopBroadcast === 'function') coopBroadcast();
  const list = $('sourcesList');
  if (!sources.length) {
    list.innerHTML = '<div class="studio-empty">Aucune caméra ajoutée. Clique sur « + Ajouter caméra ».</div>';
    updateProgramInfo();
    return;
  }
  list.innerHTML = '';
  sources.forEach((s, i) => {
    const hasAudio = s.stream.getAudioTracks().length > 0;
    const filters = getFiltersFor(s);
    const filtersOpen = openFilterPanels.has(s.id);
    const filtersActive = hasNonDefaultFilter(filters);

    const card = document.createElement('div');
    card.className = 'studio-source-card';
    card.innerHTML = `
      <div class="studio-source-preview"></div>
      <div class="studio-source-meta">
        <span class="studio-source-name">${i + 1}. ${escapeHtml(s.label)}</span>
        <div class="studio-source-actions">
          ${hasAudio ? `<button class="btn btn-sm studio-source-audio ${s.audioRouted ? 'on' : ''}" data-action="audio-toggle" title="${s.audioRouted ? 'Couper l\'audio de cette source dans le mix' : 'Inclure l\'audio de cette source dans le mix'}">${s.audioRouted ? '🔊' : '🔇'}</button>` : ''}
          <button class="btn btn-sm studio-source-filter-btn ${filtersActive || filtersOpen ? 'on' : ''}" data-action="filters" title="Filtres caméra (miroir, lumière)">⚙</button>
          <button class="btn btn-sm btn-danger studio-source-remove" data-action="remove" title="Retirer">×</button>
        </div>
      </div>
    `;
    // Aperçu live : un <video> dédié partageant le même MediaStream.
    const previewDiv = card.querySelector('.studio-source-preview');
    const liveVideo = document.createElement('video');
    liveVideo.srcObject = s.stream;
    liveVideo.autoplay = true;
    liveVideo.muted = true;
    liveVideo.playsInline = true;
    if (filters.mirror) liveVideo.classList.add('mirror');
    liveVideo.style.filter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturation}%)`;
    applyPreviewZoom(liveVideo, filters);
    previewDiv.appendChild(liveVideo);

    // Audio routé → volume slider + VU
    if (hasAudio && s.audioRouted) {
      const vol = (s.audioGainValue ?? 1.0);
      const audioRow = document.createElement('div');
      audioRow.className = 'studio-source-audio-row routed';
      audioRow.innerHTML = `
        <input type="range" class="studio-source-volume" min="0" max="150" step="1" value="${Math.round(vol * 100)}" data-action="volume">
        <span class="studio-source-volume-val">${Math.round(vol * 100)} %</span>
      `;
      card.appendChild(audioRow);
      const vu = document.createElement('div');
      vu.className = 'studio-source-vu';
      vu.id = `vu-${s.id}`;
      vu.innerHTML = '<div class="studio-source-vu-bar"></div>';
      card.appendChild(vu);
    }

    // Panneau filtres (replié par défaut)
    if (filtersOpen) {
      const panel = document.createElement('div');
      panel.className = 'studio-source-filters';
      const ptt = getPttBinding(s);
      panel.innerHTML = `
        <label class="studio-source-filter-mirror">
          <input type="checkbox" data-filter="mirror" ${filters.mirror ? 'checked' : ''}>
          <span>Miroir (flip horizontal)</span>
        </label>
        <div class="studio-source-filter-row">
          <label>Luminosité</label>
          <input type="range" data-filter="brightness" min="0" max="200" step="1" value="${filters.brightness}">
          <span class="studio-source-filter-val">${filters.brightness} %</span>
        </div>
        <div class="studio-source-filter-row">
          <label>Contraste</label>
          <input type="range" data-filter="contrast" min="0" max="200" step="1" value="${filters.contrast}">
          <span class="studio-source-filter-val">${filters.contrast} %</span>
        </div>
        <div class="studio-source-filter-row">
          <label>Saturation</label>
          <input type="range" data-filter="saturation" min="0" max="200" step="1" value="${filters.saturation}">
          <span class="studio-source-filter-val">${filters.saturation} %</span>
        </div>
        <div class="studio-source-filter-row">
          <label>Zoom (punch-in)</label>
          <input type="range" data-filter="zoom" min="100" max="300" step="5" value="${filters.zoom || 100}">
          <span class="studio-source-filter-val">${filters.zoom || 100} %</span>
        </div>
        <div class="studio-source-filter-actions">
          <button class="btn btn-sm" data-action="filter-reset">Réinitialiser</button>
        </div>
        ${hasAudio ? `
        <div class="studio-source-ptt">
          <div class="studio-source-ptt-title">🎙 Raccourci audio</div>
          <div class="studio-source-ptt-row">
            <select data-action="ptt-mode">
              <option value="off"${ptt.mode === 'off' ? ' selected' : ''}>— Aucun</option>
              <option value="ptt"${ptt.mode === 'ptt' ? ' selected' : ''}>Push-to-talk (maintenir = micro ON)</option>
              <option value="ptm"${ptt.mode === 'ptm' ? ' selected' : ''}>Push-to-mute (maintenir = micro OFF)</option>
            </select>
            <button class="btn btn-sm" data-action="ptt-bind" ${ptt.mode === 'off' ? 'disabled' : ''}>${ptt.key ? 'Touche : ' + escapeHtml(ptt.key) : 'Choisir touche'}</button>
          </div>
          <div class="studio-source-ptt-hint">Maintenir la touche pendant le service ${ptt.mode === 'ptt' ? 'active' : 'coupe'} cette source.</div>
        </div>` : ''}
      `;
      card.appendChild(panel);
    }

    // Délégation : un seul listener par carte
    card.addEventListener('click', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const action = t.dataset.action;
      if (action === 'remove') removeCamera(s.id);
      else if (action === 'audio-toggle') toggleSourceAudio(s.id);
      else if (action === 'filters') {
        if (openFilterPanels.has(s.id)) openFilterPanels.delete(s.id);
        else openFilterPanels.add(s.id);
        renderSources();
      } else if (action === 'filter-reset') {
        filtersStore[s.deviceId || s.id] = defaultFilters();
        saveFiltersStore();
        renderSources();
      } else if (action === 'ptt-bind') {
        captureNextKeyFor(s, t);
      }
    });
    // Changement du mode PTT (select n'envoie pas 'click' mais 'change')
    card.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.action === 'ptt-mode') {
        setPttBinding(s, { mode: t.value });
        renderSources();
      }
    });
    card.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.filter) {
        if (t.dataset.filter === 'mirror') filters.mirror = t.checked;
        else filters[t.dataset.filter] = parseInt(t.value, 10);
        saveFiltersStore();
        const valEl = t.parentElement.querySelector('.studio-source-filter-val');
        if (valEl && t.dataset.filter !== 'mirror') valEl.textContent = t.value + ' %';
        // Sync CSS preview live
        liveVideo.classList.toggle('mirror', !!filters.mirror);
        liveVideo.style.filter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturation}%)`;
        applyPreviewZoom(liveVideo, filters);
      } else if (t.dataset.action === 'volume') {
        const v = parseInt(t.value, 10);
        s.audioGainValue = v / 100;
        applyPttGain(s); // PTT-aware (multiplie par 0 si la touche est en mode mute)
        const valEl = card.querySelector('.studio-source-volume-val');
        if (valEl) valEl.textContent = v + ' %';
      }
    });

    list.appendChild(card);
  });
  updateProgramInfo();
}

// ============ Scènes ============
function buildSceneList() {
  const list = [];
  sources.forEach((s, i) => {
    list.push({ key: `cam-${s.id}`, label: `Cam ${i + 1} plein`, scene: { kind: 'camera', primaryId: s.id } });
    list.push({ key: `cam-verse-${s.id}`, label: `Cam ${i + 1} + verset`, scene: { kind: 'camera+verse', primaryId: s.id } });
  });
  imageSources.forEach(img => {
    list.push({ key: `img-${img.id}`, label: `🖼 ${img.name}`, scene: { kind: 'image', imageId: img.id } });
    list.push({ key: `img-verse-${img.id}`, label: `🖼 ${img.name} + verset`, scene: { kind: 'image+verse', imageId: img.id } });
  });
  cards.forEach(c => {
    list.push({ key: `card-${c.id}`, label: `🎴 ${c.name}`, scene: { kind: 'card', cardId: c.id } });
  });
  if (sources.length >= 2) {
    list.push({
      key: 'pip',
      label: `PiP (Cam 1 + Cam 2)`,
      scene: { kind: 'pip', primaryId: sources[0].id, secondaryId: sources[1].id }
    });
  }
  list.push({ key: 'verse', label: 'Verset plein écran', scene: { kind: 'verse' } });
  if (window.IntroOutro && window.IntroOutro.isConfigured('intro')) {
    list.push({ key: 'intro', label: '🎬 Intro', scene: { kind: 'intro' } });
  }
  if (window.IntroOutro && window.IntroOutro.isConfigured('outro')) {
    list.push({ key: 'outro', label: '🎬 Outro', scene: { kind: 'outro' } });
  }
  if (window.VideoLibrary && window.VideoLibrary.listScenes) {
    window.VideoLibrary.listScenes().forEach(v => list.push(v));
  }
  list.push({ key: 'black', label: 'Noir', scene: { kind: 'black' } });
  return list;
}

// Détection manuelle du double-clic sur une scène : le simple clic reconstruit
// la liste (renderScenes), donc l'élément DOM est remplacé et l'événement
// 'dblclick' natif ne peut pas se déclencher. On compare la clé + le temps.
let lastSceneClickKey = null;
let lastSceneClickTime = 0;
function isSceneDoubleClick(key) {
  const now = performance.now();
  const dbl = key === lastSceneClickKey && (now - lastSceneClickTime) < 400;
  lastSceneClickKey = dbl ? null : key;
  lastSceneClickTime = dbl ? 0 : now;
  return dbl;
}

function renderScenes() {
  const list = $('scenesList');
  const scenes = buildSceneList();
  if (!scenes.length) {
    list.innerHTML = '<div class="studio-empty">Ajoute des caméras pour générer des scènes.</div>';
    return;
  }
  const progKey = sceneKey(programScene);
  const prevKey = sceneKey(previewScene);
  list.innerHTML = '';
  scenes.forEach(s => {
    const item = document.createElement('div');
    item.className = 'studio-scene-item';
    const btn = document.createElement('button');
    btn.className = 'studio-scene-btn';
    btn.textContent = s.label;
    if (progKey === s.key) btn.classList.add('active');
    if (studioMode && prevKey === s.key && progKey !== s.key) btn.classList.add('preview-active');
    btn.addEventListener('click', () => {
      // Double-clic : envoie directement au direct (programme), sans passer par le preview.
      if (isSceneDoubleClick(s.key)) setProgramScene(s.scene);
      else setScene(s.scene);
    });
    // Case de sélection (diaporama / mosaïque) — n'affecte pas le preview.
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'studio-scene-pick';
    pick.title = 'Sélectionner pour diaporama / mosaïque';
    const selected = sceneSelection.has(s.key);
    if (selected) item.classList.add('selected');
    pick.textContent = selected ? '☑' : '☐';
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSceneSelection(s.key);
    });
    item.appendChild(btn);
    item.appendChild(pick);
    list.appendChild(item);
  });
}

function sceneKey(scene) {
  if (!scene) return 'black';
  if (scene.kind === 'camera') return `cam-${scene.primaryId}`;
  if (scene.kind === 'camera+verse') return `cam-verse-${scene.primaryId}`;
  if (scene.kind === 'image') return `img-${scene.imageId}`;
  if (scene.kind === 'image+verse') return `img-verse-${scene.imageId}`;
  if (scene.kind === 'card') return `card-${scene.cardId}`;
  if (scene.kind === 'video') return `vid-${scene.videoId}`;
  if (scene.kind === 'video+verse') return `vid-verse-${scene.videoId}`;
  if (scene.kind === 'iframe') return `iframe-${scene.videoId || scene.url}`;
  if (scene.kind === 'mosaic') return 'mosaic-' + (scene.items || []).map(sceneKey).join('_');
  if (scene.kind === 'pip') return 'pip';
  if (scene.kind === 'verse') return 'verse';
  if (scene.kind === 'intro') return 'intro';
  if (scene.kind === 'outro') return 'outro';
  return 'black';
}

// ============ Boucle de rendu programme ============
function drawVideoCover(video, x, y, w, h, source) {
  if (!video.videoWidth) return;
  const sAR = video.videoWidth / video.videoHeight;
  const dAR = w / h;
  let sx, sy, sw, sh;
  if (sAR > dAR) {
    // source plus large → on rogne sur les côtés
    sh = video.videoHeight;
    sw = sh * dAR;
    sx = (video.videoWidth - sw) / 2;
    sy = 0;
  } else {
    sw = video.videoWidth;
    sh = sw / dAR;
    sx = 0;
    sy = (video.videoHeight - sh) / 2;
  }
  const filters = source ? getFiltersFor(source) : null;
  // Punch-in numérique : on rogne un cadre plus serré dans la zone source.
  // zoom=100 → pas de zoom, zoom=300 → x3 (l'image source effective fait un tiers).
  // Centré sur le milieu du cadre cover.
  if (filters) {
    const z = Math.max(100, Math.min(300, filters.zoom || 100)) / 100;
    if (z > 1) {
      const newSw = sw / z, newSh = sh / z;
      sx = sx + (sw - newSw) / 2;
      sy = sy + (sh - newSh) / 2;
      sw = newSw; sh = newSh;
    }
  }
  const needsFilter = filters && hasColorFilter(filters);
  const needsMirror = filters && filters.mirror;
  if (needsFilter || needsMirror) {
    activeCtx.save();
    if (needsFilter) {
      activeCtx.filter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturation}%)`;
    }
    if (needsMirror) {
      activeCtx.translate(x + w, y);
      activeCtx.scale(-1, 1);
      activeCtx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    } else {
      activeCtx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
    }
    activeCtx.restore();
  } else {
    activeCtx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
  }
}

function drawImageContain(imgEl, x, y, w, h) {
  if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) return;
  const sAR = imgEl.naturalWidth / imgEl.naturalHeight;
  const dAR = w / h;
  let dw, dh;
  if (sAR > dAR) { dw = w; dh = w / sAR; }
  else           { dh = h; dw = h * sAR; }
  activeCtx.drawImage(imgEl, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// Cover : remplit la zone, peut rogner. Contain : tient dans la zone, peut laisser des bandes.
function drawImageCover(imgEl, x, y, w, h, mode) {
  if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) return;
  if (mode === 'contain') return drawImageContain(imgEl, x, y, w, h);
  const sAR = imgEl.naturalWidth / imgEl.naturalHeight;
  const dAR = w / h;
  let sx, sy, sw, sh;
  if (sAR > dAR) {
    sh = imgEl.naturalHeight;
    sw = sh * dAR;
    sx = (imgEl.naturalWidth - sw) / 2;
    sy = 0;
  } else {
    sw = imgEl.naturalWidth;
    sh = sw / dAR;
    sx = 0;
    sy = (imgEl.naturalHeight - sh) / 2;
  }
  activeCtx.drawImage(imgEl, sx, sy, sw, sh, x, y, w, h);
}

// Cache d'images de fond par dataURL (clé) → Image. Évite de recréer l'<img>
// à chaque frame quand verseState.style.bgImage est stable.
let _bgImageCacheKey = null;
let _bgImageCacheImg = null;
function getCachedBgImage(dataUrl) {
  if (!dataUrl) return null;
  if (_bgImageCacheKey === dataUrl && _bgImageCacheImg) return _bgImageCacheImg;
  const img = new Image();
  img.src = dataUrl;
  _bgImageCacheKey = dataUrl;
  _bgImageCacheImg = img;
  return img;
}

function drawLogoOverlay() {
  if (!logoOverlayEnabled || !logoOverlayId) return;
  const img = imageSources.find(i => i.id === logoOverlayId);
  if (!img || !img.imgEl || !img.imgEl.complete) return;
  const logoW = OUTPUT_W * 0.12;
  const ar = img.imgEl.naturalWidth / (img.imgEl.naturalHeight || 1);
  const logoH = logoW / (ar || 1);
  const pad = 40;
  drawImageContain(img.imgEl, OUTPUT_W - logoW - pad, pad, logoW, logoH);
}

function drawVerseOverlay(area) {
  if (!verseState) return;
  const style = verseState.style || {};

  // Réduction manuelle du bloc image + verset (réglée depuis le panneau).
  // On dessine tout (image, fond, texte) dans une sous-zone centrée plus petite ;
  // la police est mise à l'échelle d'autant pour rester proportionnée.
  // Neutralisée (1) pour les titres, qui gardent leur pleine taille.
  const sceneScale = verseState.kind === 'title'
    ? 1
    : (style.sceneScale != null ? Math.max(0.1, Math.min(1, style.sceneScale)) : 1);
  // Décalage manuel du bloc (image + texte) : fraction de la zone, -0.5..0.5.
  // 0 = centré (comportement historique). Neutralisé pour les titres.
  const offX = verseState.kind === 'title'
    ? 0
    : (style.sceneOffsetX != null ? Math.max(-0.5, Math.min(0.5, style.sceneOffsetX)) : 0);
  const offY = verseState.kind === 'title'
    ? 0
    : (style.sceneOffsetY != null ? Math.max(-0.5, Math.min(0.5, style.sceneOffsetY)) : 0);
  const w = area.w * sceneScale;
  const h = area.h * sceneScale;
  const x = area.x + (area.w - w) / 2 + offX * area.w;
  const y = area.y + (area.h - h) / 2 + offY * area.h;

  // Image de fond optionnelle (sous le fond couleur/dégradé/bandeau).
  // Cachée par dataURL pour éviter de recréer un Image() à chaque frame.
  if (style.bgImage) {
    const img = getCachedBgImage(style.bgImage);
    if (img && img.complete && img.naturalWidth) {
      // Taille de l'image de fond, réglable indépendamment du bloc (1 = pleine zone).
      const bgScale = style.bgImageScale != null ? Math.max(0.1, Math.min(1, style.bgImageScale)) : 1;
      // Décalage de l'image SEULE dans le bloc (indépendant du texte).
      const bgOffX = style.bgImageOffsetX != null ? Math.max(-0.5, Math.min(0.5, style.bgImageOffsetX)) : 0;
      const bgOffY = style.bgImageOffsetY != null ? Math.max(-0.5, Math.min(0.5, style.bgImageOffsetY)) : 0;
      const iw = w * bgScale, ih = h * bgScale;
      const ix = x + (w - iw) / 2 + bgOffX * w, iy = y + (h - ih) / 2 + bgOffY * h;
      drawImageCover(img, ix, iy, iw, ih, style.bgImageFit || 'cover');
      const dim = style.bgImageDim != null ? Math.max(0, Math.min(1, style.bgImageDim)) : 0;
      if (dim > 0) {
        activeCtx.fillStyle = `rgba(0,0,0,${dim})`;
        activeCtx.fillRect(ix, iy, iw, ih);
      }
    }
  }

  // Fond du verset
  const bgType = style.bgType || 'transparent';
  if (bgType !== 'transparent') {
    const bgColor = style.bgColor || '#000000';
    const bgOpacity = style.bgOpacity != null ? style.bgOpacity : 0.5;
    activeCtx.fillStyle = hexWithAlpha(bgColor, bgOpacity);
    if (bgType === 'overlay') {
      // bandeau centré
      const bw = w * 0.85;
      const bh = h * 0.6;
      activeCtx.fillRect(x + (w - bw) / 2, y + (h - bh) / 2, bw, bh);
    } else {
      activeCtx.fillRect(x, y, w, h);
    }
  }

  const text = (verseState.text || '').trim();
  const ref = verseState.reference || '';
  if (!text && verseState.kind !== 'title') return;

  // Style texte
  const fontFamily = style.fontFamily || 'Georgia, serif';
  const fontSizeVw = style.fontSize || 4.5;
  // 4.5vw → en px sur 1920 = 4.5/100 * 1920 = 86.4 (réduit avec le bloc).
  // baseW = largeur de référence : OUTPUT_W en plein écran, mais largeur de la
  // cellule en mosaïque (area.baseW) pour garder le texte proportionné.
  const baseW = area.baseW || OUTPUT_W;
  const fontSizePx = Math.round((fontSizeVw / 100) * baseW * sceneScale);
  const refSizePx = Math.max(Math.round(fontSizePx * 0.5), 28);
  const color = style.textColor || '#ffffff';
  const align = style.textAlign || 'center';

  activeCtx.fillStyle = color;
  activeCtx.textAlign = align;
  activeCtx.textBaseline = 'middle';

  // Décalage du texte SEUL dans le bloc (indépendant de l'image de fond).
  // Neutralisé pour les titres (comme sceneOffset).
  const txtOffX = verseState.kind === 'title'
    ? 0
    : (style.textOffsetX != null ? Math.max(-0.5, Math.min(0.5, style.textOffsetX)) : 0);
  const txtOffY = verseState.kind === 'title'
    ? 0
    : (style.textOffsetY != null ? Math.max(-0.5, Math.min(0.5, style.textOffsetY)) : 0);

  // Position alignement
  const padX = w * 0.05;
  const padY = h * 0.08;
  const textX = (align === 'left' ? x + padX : align === 'right' ? x + w - padX : x + w / 2) + txtOffX * w;

  // Ombre
  applyShadow(style.textShadow || 'soft');

  // Verset (multi-lignes en respectant la largeur)
  if (verseState.kind === 'title') {
    drawTitle(verseState, x, y, w, h, fontSizePx, fontFamily, color, align);
  } else if (text) {
    // Ajustement auto : on réduit la police jusqu'à ce que le verset (lignes +
    // référence) tienne dans la zone disponible. Évite le débordement quand le
    // verset est confiné au tiers inférieur (camera+verse / image+verse) ou
    // qu'il est simplement trop long pour la taille réglée dans le panneau.
    const maxTextW = w - padX * 2;
    const maxTextH = h - padY * 2;
    const showRef = ref && (style.showRef || 'below') !== 'hide';
    let fs = fontSizePx;
    let refFs = refSizePx;
    let lines = wrapText('« ' + text + ' »', maxTextW, fs, fontFamily);
    let lineHeight = fs * 1.25;
    let totalH = lines.length * lineHeight + (showRef ? refFs * 1.8 : 0);
    let guard = 0;
    while (totalH > maxTextH && fs > 14 && guard++ < 60) {
      fs = Math.max(14, Math.floor(fs * 0.94));
      refFs = Math.max(Math.round(fs * 0.5), 22);
      lines = wrapText('« ' + text + ' »', maxTextW, fs, fontFamily);
      lineHeight = fs * 1.25;
      totalH = lines.length * lineHeight + (showRef ? refFs * 1.8 : 0);
    }

    const vAlign = style.vAlign || 'center';
    let startY;
    if (vAlign === 'top') startY = y + padY + lineHeight / 2;
    else if (vAlign === 'bottom') startY = y + h - padY - totalH + lineHeight / 2;
    else startY = y + (h - totalH) / 2 + lineHeight / 2;
    startY += txtOffY * h;

    activeCtx.font = `${fs}px ${fontFamily}`;
    lines.forEach((line, i) => activeCtx.fillText(line, textX, startY + i * lineHeight));

    // Référence
    if (showRef) {
      activeCtx.font = `italic ${refFs}px ${fontFamily}`;
      const refY = (style.showRef === 'above')
        ? startY - lineHeight
        : startY + lines.length * lineHeight + refFs * 0.3;
      activeCtx.fillText(ref, textX, refY);
    }
  }

  resetShadow();
}

function drawTitle(state, x, y, w, h, baseFont, fontFamily, color, align) {
  const main = state.title || '';
  const sub = state.subtitle || '';
  const mainSize = Math.round(baseFont * 1.4);
  const subSize = Math.round(baseFont * 0.55);
  const mx = align === 'left' ? x + w * 0.05 : align === 'right' ? x + w - w * 0.05 : x + w / 2;
  activeCtx.fillStyle = color;
  activeCtx.textAlign = align;
  activeCtx.textBaseline = 'middle';
  activeCtx.font = `bold ${mainSize}px ${fontFamily}`;
  activeCtx.fillText(main, mx, y + h / 2 - subSize);
  if (sub) {
    activeCtx.font = `${subSize}px ${fontFamily}`;
    activeCtx.fillStyle = state.accent || '#d4af37';
    activeCtx.fillText(sub, mx, y + h / 2 + mainSize * 0.6);
  }
}

function wrapText(text, maxWidth, fontSize, fontFamily) {
  activeCtx.font = `${fontSize}px ${fontFamily}`;
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (activeCtx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function applyShadow(kind) {
  if (kind === 'none') {
    activeCtx.shadowColor = 'transparent'; activeCtx.shadowBlur = 0;
  } else if (kind === 'strong') {
    activeCtx.shadowColor = 'rgba(0,0,0,0.9)'; activeCtx.shadowBlur = 14;
    activeCtx.shadowOffsetX = 4; activeCtx.shadowOffsetY = 4;
  } else if (kind === 'outline') {
    activeCtx.shadowColor = 'rgba(0,0,0,1)'; activeCtx.shadowBlur = 6;
  } else if (kind === 'glow') {
    activeCtx.shadowColor = 'rgba(212,175,55,0.85)'; activeCtx.shadowBlur = 24;
  } else { // soft
    activeCtx.shadowColor = 'rgba(0,0,0,0.7)'; activeCtx.shadowBlur = 8;
    activeCtx.shadowOffsetX = 2; activeCtx.shadowOffsetY = 2;
  }
}
function resetShadow() {
  activeCtx.shadowColor = 'transparent';
  activeCtx.shadowBlur = 0;
  activeCtx.shadowOffsetX = 0;
  activeCtx.shadowOffsetY = 0;
}

function setScene(scene) {
  if (studioMode) {
    setPreviewScene(scene);
  } else {
    setProgramScene(scene);
  }
}

// Mémorise la scène à laquelle revenir quand une vidéo se termine
let preVideoScene = null;

// ============ Sélection multiple : diaporama & mosaïque ============
// L'utilisateur coche plusieurs scènes (images, versets, vidéos, titres,
// cartes…) puis les lance soit en diaporama (l'une après l'autre, auto/manuel),
// soit en mosaïque (toutes en même temps sur une grille).
// Set = conserve l'ordre d'insertion → ordre de lecture du diaporama.
const sceneSelection = new Set();

function toggleSceneSelection(key) {
  if (sceneSelection.has(key)) sceneSelection.delete(key);
  else sceneSelection.add(key);
  renderScenes();
  renderSelectionBar();
}

function clearSceneSelection() {
  sceneSelection.clear();
  renderScenes();
  renderSelectionBar();
}

// Résout les clés sélectionnées en objets scène, dans l'ordre de sélection.
function getSelectedScenes() {
  const map = new Map(buildSceneList().map(it => [it.key, it.scene]));
  return [...sceneSelection].map(k => map.get(k)).filter(Boolean);
}

function renderSelectionBar() {
  const bar = $('selectionBar');
  if (!bar) return;
  const n = sceneSelection.size;
  // La barre reste toujours visible (découvrabilité). On active/désactive juste
  // les actions et on adapte le compteur selon la sélection.
  const count = $('selectionCount');
  if (count) {
    count.textContent = n === 0
      ? 'Coche des scènes (☐) pour lancer un diaporama ou une mosaïque'
      : n + (n > 1 ? ' éléments sélectionnés' : ' élément sélectionné');
  }
  ['startSlideshowBtn', 'startMosaicBtn', 'clearSelectionBtn'].forEach(id => {
    const b = $(id);
    if (b) b.disabled = n === 0;
  });
}

// ----- Diaporama (lecture en suite) -----
let slideshow = null; // { items, index, durationMs, loop, timer }
let slideshowAdvancing = false; // true pendant que le diaporama pilote setProgramScene

function startSlideshow() {
  const items = getSelectedScenes();
  if (!items.length) { toast('Sélectionne au moins un élément', true); return; }
  const durSec = parseFloat($('slideshowDuration')?.value) || 6;
  const loop = !!($('slideshowLoop') && $('slideshowLoop').checked);
  slideshow = { items, index: 0, durationMs: Math.max(1, durSec) * 1000, loop, timer: null };
  const c = $('slideshowControls'); if (c) c.style.display = 'flex';
  playSlideAt(0);
}

function playSlideAt(i) {
  if (!slideshow) return;
  slideshow.index = i;
  const scene = slideshow.items[i];
  slideshowAdvancing = true;
  setProgramScene(scene);
  slideshowAdvancing = false;
  if (slideshow.timer) { clearTimeout(slideshow.timer); slideshow.timer = null; }
  // Les vidéos avancent à la fin de lecture (onVideoEnded), pas au minuteur.
  const isVideo = scene && (scene.kind === 'video' || scene.kind === 'video+verse');
  if (!isVideo) slideshow.timer = setTimeout(() => slideshowNext(), slideshow.durationMs);
  const st = $('slideshowStatus');
  if (st) st.textContent = `${i + 1} / ${slideshow.items.length}`;
}

function slideshowNext() {
  if (!slideshow) return;
  let next = slideshow.index + 1;
  if (next >= slideshow.items.length) {
    if (slideshow.loop) next = 0;
    else { stopSlideshow(); return; }
  }
  playSlideAt(next);
}

function slideshowPrev() {
  if (!slideshow) return;
  let prev = slideshow.index - 1;
  if (prev < 0) prev = slideshow.loop ? slideshow.items.length - 1 : 0;
  playSlideAt(prev);
}

function stopSlideshow() {
  if (slideshow && slideshow.timer) clearTimeout(slideshow.timer);
  slideshow = null;
  const c = $('slideshowControls'); if (c) c.style.display = 'none';
}

// ----- Mosaïque (affichage simultané) -----
function startMosaic() {
  const items = getSelectedScenes();
  if (!items.length) { toast('Sélectionne au moins un élément', true); return; }
  stopSlideshow();
  setProgramScene({ kind: 'mosaic', items: items.slice(0, 16) });
}

// Grille adaptée au nombre d'éléments (max 16).
function mosaicGrid(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  if (n <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

// Dessine n'importe quelle scène dans un rectangle (cellule de mosaïque).
// Réutilise les routines de rendu existantes : celles basées sur des coords
// absolues reçoivent x,y ; celles qui dessinent en (0,0) sont décalées par
// translate().
function drawSceneInRect(s, x, y, w, h) {
  if (!s) return;
  activeCtx.save();
  activeCtx.beginPath();
  activeCtx.rect(x, y, w, h);
  activeCtx.clip();
  activeCtx.fillStyle = '#000';
  activeCtx.fillRect(x, y, w, h);
  const k = s.kind;
  if (k === 'camera' || k === 'camera+verse' || k === 'pip') {
    const src = getSourceForScene(s, 'primary');
    if (src) drawVideoCover(src.videoEl, x, y, w, h, src);
  } else if (k === 'image' || k === 'image+verse') {
    const img = getImageForScene(s);
    if (img && img.imgEl) drawImageContain(img.imgEl, x, y, w, h);
  } else if (k === 'card') {
    const card = getCardById(s.cardId);
    if (card) { activeCtx.translate(x, y); drawCardContent(activeCtx, card, w, h); }
  } else if (k === 'verse') {
    drawVerseOverlay({ x, y, w, h, baseW: w });
  } else if (k === 'intro' || k === 'outro') {
    if (window.IntroOutro) { activeCtx.translate(x, y); window.IntroOutro.draw(activeCtx, k, w, h); }
  } else if (k === 'video' || k === 'video+verse') {
    if (window.VideoLibrary) { activeCtx.translate(x, y); window.VideoLibrary.draw(activeCtx, s.videoId, w, h); }
  } else if (k === 'iframe') {
    activeCtx.fillStyle = '#0a0a0a'; activeCtx.fillRect(x, y, w, h);
    activeCtx.fillStyle = '#888'; activeCtx.textAlign = 'center'; activeCtx.textBaseline = 'middle';
    activeCtx.font = `${Math.round(h * 0.1)}px -apple-system, sans-serif`;
    activeCtx.fillText('▶ externe', x + w / 2, y + h / 2);
  }
  activeCtx.restore();
}

function drawMosaic(s) {
  activeCtx.fillStyle = '#131536';
  activeCtx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
  const items = (s.items || []).slice(0, 16);
  const n = items.length;
  if (!n) return;
  const { cols, rows } = mosaicGrid(n);
  const gap = Math.round(OUTPUT_W * 0.006);
  const cw = (OUTPUT_W - gap * (cols + 1)) / cols;
  const ch = (OUTPUT_H - gap * (rows + 1)) / rows;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const x = gap + c * (cw + gap), y = gap + r * (ch + gap);
    try { drawSceneInRect(items[i], x, y, cw, ch); } catch (e) {}
  }
}

function bindSelectionUi() {
  const start = $('startSlideshowBtn');
  if (start) start.addEventListener('click', startSlideshow);
  const mosaic = $('startMosaicBtn');
  if (mosaic) mosaic.addEventListener('click', startMosaic);
  const clear = $('clearSelectionBtn');
  if (clear) clear.addEventListener('click', clearSceneSelection);
  const prev = $('slidePrevBtn');
  if (prev) prev.addEventListener('click', slideshowPrev);
  const next = $('slideNextBtn');
  if (next) next.addEventListener('click', slideshowNext);
  const stop = $('slideStopBtn');
  if (stop) stop.addEventListener('click', stopSlideshow);
  // Contrôles de diaporama masqués tant qu'aucun diaporama n'est lancé
  // (style.display explicite : robuste face au piège [hidden] + display:flex).
  const c = $('slideshowControls'); if (c) c.style.display = 'none';
  renderSelectionBar();
}

function setProgramScene(scene) {
  // Si l'opérateur reprend la main pendant un diaporama (autre que l'avance
  // pilotée par le diaporama lui-même), on arrête le diaporama.
  if (slideshow && !slideshowAdvancing) stopSlideshow();
  if (sceneKey(programScene) === sceneKey(scene)) return;
  // Si on passe à une vidéo, mémoriser la scène précédente (pour retour auto)
  const isVid = (k) => k === 'video' || k === 'video+verse';
  if (isVid(scene.kind) && !isVid(programScene.kind)) {
    preVideoScene = programScene;
  }
  // Si on quitte une vidéo manuellement (pas par fin de vidéo), oublier le retour auto
  if (isVid(programScene.kind) && !isVid(scene.kind)) {
    preVideoScene = null;
  }
  previousProgramScene = programScene;
  programScene = scene;
  transitionStart = performance.now();
  renderScenes();
  // Trigger audio MP3 de l'intro/outro si applicable
  if (window.IntroOutro) window.IntroOutro.onSceneChange(scene);
  // Trigger lecture vidéo si applicable
  if (window.VideoLibrary) window.VideoLibrary.onSceneChange(scene);
  // Iframe (YouTube/Vimeo) : push l'URL au projecteur, sinon le retire.
  syncIframeToProjector(scene);
  // Auto-switch TV : texte si scène 'verse'/'black', snapshot canvas sinon
  autoSwitchTvForScene(scene);
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

function syncIframeToProjector(scene) {
  // On a besoin d'une fenêtre projecteur ouverte pour la lecture iframe.
  if (scene.kind === 'iframe') {
    if (!outputWindow || outputWindow.closed) {
      toast('Ouvre d\'abord 📽 Sortie projecteur pour lire un lien YouTube/Vimeo', true);
      return;
    }
    try { outputWindow.setIframeUrl && outputWindow.setIframeUrl(scene.url); } catch (e) {}
  } else if (outputWindow && !outputWindow.closed) {
    try { outputWindow.clearIframe && outputWindow.clearIframe(); } catch (e) {}
  }
}

function setPreviewScene(scene) {
  previewScene = scene;
  renderScenes();
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

function takeProgram() {
  if (!studioMode) return;
  // Bascule la scène preview vers le program, avec la transition configurée
  setProgramScene(previewScene);
}

function getSourceForScene(scene, role) {
  // role: 'primary' | 'secondary'
  const id = role === 'primary' ? scene.primaryId : scene.secondaryId;
  return sources.find(s => s.id === id);
}
function getImageForScene(scene) {
  return imageSources.find(i => i.id === scene.imageId);
}

function drawScene(s) {
  if (s.kind === 'camera' || s.kind === 'camera+verse') {
    const src = getSourceForScene(s, 'primary');
    if (src) drawVideoCover(src.videoEl, 0, 0, OUTPUT_W, OUTPUT_H, src);
    drawLogoOverlay();
    if (s.kind === 'camera+verse') {
      // Verset en bas, sur le tiers inférieur, fond translucide
      const h = OUTPUT_H * 0.30;
      activeCtx.fillStyle = 'rgba(0,0,0,0.55)';
      activeCtx.fillRect(0, OUTPUT_H - h, OUTPUT_W, h);
      drawVerseOverlay({ x: 0, y: OUTPUT_H - h, w: OUTPUT_W, h });
    }
  } else if (s.kind === 'pip') {
    const main = getSourceForScene(s, 'primary');
    const corner = getSourceForScene(s, 'secondary');
    if (main) drawVideoCover(main.videoEl, 0, 0, OUTPUT_W, OUTPUT_H, main);
    if (corner) {
      const pipW = OUTPUT_W * 0.28;
      const pipH = pipW * 9 / 16;
      const pipX = OUTPUT_W - pipW - 40;
      const pipY = 40;
      activeCtx.fillStyle = '#fff';
      activeCtx.fillRect(pipX - 4, pipY - 4, pipW + 8, pipH + 8);
      drawVideoCover(corner.videoEl, pipX, pipY, pipW, pipH, corner);
    }
    drawLogoOverlay();
  } else if (s.kind === 'image' || s.kind === 'image+verse') {
    const img = getImageForScene(s);
    if (img && img.imgEl) {
      // Taille + position réglables PAR IMAGE (centrée, marge autour si < 100 %).
      // Repli sur la taille globale (fullImageScale) pour les images sans réglage
      // propre, afin de préserver le comportement existant.
      const sc = img.scale != null
        ? Math.max(0.1, Math.min(1, img.scale))
        : Math.max(0.1, Math.min(1, fullImageScale));
      const ox = img.offsetX != null ? Math.max(-0.5, Math.min(0.5, img.offsetX)) : 0;
      const oy = img.offsetY != null ? Math.max(-0.5, Math.min(0.5, img.offsetY)) : 0;
      const iw = OUTPUT_W * sc, ih = OUTPUT_H * sc;
      drawImageContain(img.imgEl, (OUTPUT_W - iw) / 2 + ox * OUTPUT_W, (OUTPUT_H - ih) / 2 + oy * OUTPUT_H, iw, ih);
    }
    if (s.kind === 'image+verse') {
      const h = OUTPUT_H * 0.30;
      activeCtx.fillStyle = 'rgba(0,0,0,0.55)';
      activeCtx.fillRect(0, OUTPUT_H - h, OUTPUT_W, h);
      drawVerseOverlay({ x: 0, y: OUTPUT_H - h, w: OUTPUT_W, h });
    }
  } else if (s.kind === 'card') {
    const card = getCardById(s.cardId);
    if (card) drawCardContent(activeCtx, card, OUTPUT_W, OUTPUT_H);
  } else if (s.kind === 'verse') {
    drawVerseOverlay({ x: 0, y: 0, w: OUTPUT_W, h: OUTPUT_H });
  } else if (s.kind === 'mosaic') {
    drawMosaic(s);
  } else if (s.kind === 'intro' || s.kind === 'outro') {
    if (window.IntroOutro) window.IntroOutro.draw(activeCtx, s.kind, OUTPUT_W, OUTPUT_H);
  } else if (s.kind === 'video' || s.kind === 'video+verse') {
    if (window.VideoLibrary) window.VideoLibrary.draw(activeCtx, s.videoId, OUTPUT_W, OUTPUT_H);
    if (s.kind === 'video+verse') {
      const h = OUTPUT_H * 0.30;
      activeCtx.fillStyle = 'rgba(0,0,0,0.55)';
      activeCtx.fillRect(0, OUTPUT_H - h, OUTPUT_W, h);
      drawVerseOverlay({ x: 0, y: OUTPUT_H - h, w: OUTPUT_W, h });
    }
  } else if (s.kind === 'iframe') {
    // La lecture réelle se fait dans la fenêtre projecteur via une iframe ;
    // le canvas (et donc le live RTMP) ne reçoit qu'un placeholder.
    activeCtx.fillStyle = '#0a0a0a';
    activeCtx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
    activeCtx.fillStyle = '#888';
    activeCtx.textAlign = 'center';
    activeCtx.font = `${Math.round(OUTPUT_H * 0.06)}px -apple-system, sans-serif`;
    activeCtx.fillText('▶ Lecture externe sur le projecteur', OUTPUT_W / 2, OUTPUT_H / 2 - 10);
    activeCtx.fillStyle = '#555';
    activeCtx.font = `${Math.round(OUTPUT_H * 0.035)}px -apple-system, sans-serif`;
    activeCtx.fillText(s.label || '', OUTPUT_W / 2, OUTPUT_H / 2 + Math.round(OUTPUT_H * 0.06));
  }
  // 'black' → rien à dessiner
}

// Cap le rendu à OUTPUT_FPS (30) pour éviter de dessiner à la fréquence native
// du moniteur (60-120 Hz sur Mac récent), ce qui faisait travailler captureStream,
// les 3 MediaRecorders (record + stream + replay) et le projecteur à 2-4× le débit
// utile. Conséquence observée : latence, saccades et baisse de bitrate par les
// encodeurs sous-CPU.
const RENDER_INTERVAL_MS = 1000 / OUTPUT_FPS;
let lastRenderTime = 0;

// Dessine une frame (program + preview) sur les canvas. Séparé de l'ordonnancement
// pour pouvoir être piloté soit par requestAnimationFrame (au premier plan), soit par
// le timer de secours (en arrière-plan, voir bgRenderTimer plus bas).
let frameCounter = 0;

// Sous charge (record/stream/replay), l'aperçu n'a pas besoin des 30 fps pleins :
// on le rafraîchit moins souvent pour libérer du CPU au profit du programme.
// Le programme (et donc le projecteur) reste toujours à 30 fps.
function previewDividerForLoad() {
  if (!smoothPriorityOn) return 1;
  const load = getEncoderLoad();
  return load >= 3 ? 4 : load >= 2 ? 3 : load >= 1 ? 2 : 1;
}

function drawProgramFrame() {
  frameCounter++;
  // ---------- Program ----------
  activeCtx = ctx;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);

  const tElapsed = performance.now() - transitionStart;
  const transDur = transitionCfg.kind === 'cut' ? 0 : transitionCfg.durationMs;
  if (previousProgramScene && transDur > 0 && tElapsed < transDur) {
    const t = tElapsed / transDur; // 0 → 1
    applyTransition(transitionCfg.kind, t, previousProgramScene, programScene);
  } else {
    if (previousProgramScene) previousProgramScene = null;
    drawScene(programScene);
  }
  // Bande d'annonce : overlay global par-dessus la scène/transition (programme).
  // `true` → fait avancer le défilement une seule fois par frame.
  drawTicker(true);

  // ---------- Preview (uniquement si studio mode actif, allégé sous charge) ----------
  if (studioMode && frameCounter % previewDividerForLoad() === 0) {
    activeCtx = previewCtx;
    previewCtx.fillStyle = '#000';
    previewCtx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
    drawScene(previewScene);
    drawTicker(false); // même bande sur le preview, sans ré-avancer le défilement
    activeCtx = ctx;
  }
}

// Dessine la bande d'annonce défilante en boucle (overlay global, au-dessus de
// toutes les scènes ; incluse automatiquement dans la diffusion via captureStream).
// advance=true uniquement pour le passage PROGRAMME → le défilement n'avance
// qu'une fois par frame (indépendant du framerate via performance.now()).
const TICKER_SEP = '        •        ';
function drawTicker(advance) {
  if (!tickerCfg.enabled) return;
  const msgs = tickerCfg.messages.map(m => (m || '').trim()).filter(Boolean);
  if (!msgs.length) return;

  const c = activeCtx;
  // Police = taille de base (3,75% de la hauteur) × réglage de taille.
  // La bande grandit avec la police (≈2×) pour ne jamais rogner le texte,
  // plafonnée à 28% de la hauteur. La graisse est réglable.
  const scale = tickerCfg.fontScale || 1;
  const weight = tickerCfg.weight || 600;
  const fontPx = Math.round(OUTPUT_H * 0.0375 * scale);
  const bandH = Math.min(Math.round(OUTPUT_H * 0.28), Math.round(fontPx * 2));
  // Position verticale réglable : posY 0 = en bas (défaut), 1 = en haut.
  const posY = Math.max(0, Math.min(1, tickerCfg.posY ?? 0));
  const bandY = Math.round((OUTPUT_H - bandH) * (1 - posY));
  const font = `${weight} ${fontPx}px -apple-system, "Segoe UI", system-ui, sans-serif`;

  // Texte complet : messages séparés + séparateur final → boucle sans couture.
  const full = msgs.join(TICKER_SEP) + TICKER_SEP;
  c.font = font;
  const textW = c.measureText(full).width;
  if (textW <= 0) return;

  // Offset px du début de chaque annonce dans le cycle (pour les sauts préc/suiv manuels).
  const sepW = c.measureText(TICKER_SEP).width;
  tickerStarts = [];
  let acc = 0;
  for (const m of msgs) {
    tickerStarts.push(acc);
    acc += c.measureText(m).width + sepW;
  }

  // Avance du défilement (bornée pour éviter un saut après une pause/onglet caché).
  if (advance) {
    const now = performance.now();
    if (tickerLastTs && !tickerPaused) {
      const dt = Math.min(0.1, (now - tickerLastTs) / 1000);
      tickerOffset += tickerCfg.speed * dt;
    }
    tickerLastTs = now; // tenu à jour même en pause → pas de saut à la reprise
    tickerOffset %= textW;
  }

  c.save();
  // Fond de la bande + fin liseré supérieur.
  c.fillStyle = hexWithAlpha(tickerCfg.bgColor, 0.82);
  c.fillRect(0, bandY, OUTPUT_W, bandH);
  c.fillStyle = hexWithAlpha(tickerCfg.textColor, 0.25);
  c.fillRect(0, bandY, OUTPUT_W, Math.max(2, Math.round(bandH * 0.04)));
  // Clip à la bande puis texte répété (défilement circulaire).
  c.beginPath();
  c.rect(0, bandY, OUTPUT_W, bandH);
  c.clip();
  c.font = font;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillStyle = tickerCfg.textColor;
  const midY = bandY + bandH / 2;
  let x = -tickerOffset;
  let guard = 0;
  while (x < OUTPUT_W && guard++ < 60) {
    c.fillText(full, x, midY);
    x += textW;
  }
  c.restore();
}

// Saut manuel à l'annonce précédente / suivante (snap sur le début du message).
// dir = -1 (préc.) ou +1 (suiv.). S'appuie sur tickerStarts calculé au dernier rendu.
function tickerJump(dir) {
  const n = tickerStarts.length;
  if (!n) return;
  // Annonce courante = dernière dont le début a déjà passé le bord gauche.
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (tickerOffset >= tickerStarts[i] - 1) cur = i;
  }
  const target = ((cur + dir) % n + n) % n;
  tickerOffset = tickerStarts[target];
}
function tickerSetPaused(p) {
  tickerPaused = p;
  tickerLastTs = performance.now();
}

// Tente un rendu si l'intervalle 30 fps est écoulé. Renvoie true si une frame a été
// dessinée. La grille temporelle évite la dérive cumulée et déduplique les appels
// quand rAF et le timer de secours tournent en même temps.
let perfFramesDrawn = 0;
let perfLateFrames = 0;
let perfLastDrawTs = 0;
function renderTick() {
  const ts = performance.now();
  const elapsed = ts - lastRenderTime;
  if (elapsed < RENDER_INTERVAL_MS - 2) return false;
  lastRenderTime = ts - (elapsed % RENDER_INTERVAL_MS);
  drawProgramFrame();
  // Mesure perf : compte les frames dessinées et celles en retard (boucle qui décroche).
  perfFramesDrawn++;
  if (perfLastDrawTs && (ts - perfLastDrawTs) > RENDER_INTERVAL_MS * 1.8) perfLateFrames++;
  perfLastDrawTs = ts;
  return true;
}

// ===== Charge des encodeurs (record + stream RTMP + replay buffer) =====
function getEncoderLoad() {
  const recording = !!(mediaRecorder && mediaRecorder.state === 'recording');
  const streaming = !!relayStreaming;
  const buffering = isReplayBufferOn();
  return (recording ? 1 : 0) + (streaming ? 1 : 0) + (buffering ? 1 : 0);
}

// ===== Indicateur de performance (HUD) =====
let perfHudTimer = null;
function startPerfHud() {
  if (perfHudTimer) return;
  perfHudTimer = setInterval(() => {
    const fps = perfFramesDrawn; perfFramesDrawn = 0;
    const late = perfLateFrames; perfLateFrames = 0;
    maybeAutoResolution();
    updatePerfHud(fps, late);
  }, 1000);
}

// ===== Baisse auto de résolution sous charge (opt-in) =====
// Réduit le canvas en 720p quand 2+ encodeurs tournent, pour alléger l'encodage
// (WebM record/replay tolèrent un changement de résolution). JAMAIS pendant un live
// RTMP (un changement de résolution casserait le flux). Ne touche pas la qualité
// choisie par l'utilisateur : on restaure dès que la charge retombe.
let autoResActive = false;
function maybeAutoResolution() {
  if (relayStreaming) return; // ne jamais changer la résolution pendant une diffusion RTMP
  if (!autoResOn) { if (autoResActive) restoreUserResolution(); return; }
  const load = getEncoderLoad();
  if (load >= 2 && currentQuality === '1080p' && !autoResActive) {
    OUTPUT_W = 1280; OUTPUT_H = 720;
    if (programCanvas) { programCanvas.width = 1280; programCanvas.height = 720; }
    const pc = document.getElementById('previewCanvas');
    if (pc) { pc.width = 1280; pc.height = 720; }
    autoResActive = true;
    toast('Priorité fluidité : canvas abaissé en 720p le temps de la charge.');
  } else if (load < 2 && autoResActive) {
    restoreUserResolution();
  }
}
function restoreUserResolution() {
  autoResActive = false;
  applyQualityToCanvases(); // remet la résolution choisie par l'utilisateur
}
function updatePerfHud(fps, late) {
  const el = document.getElementById('perfHud');
  if (!el) return;
  el.hidden = !perfHudOn;
  if (!perfHudOn) return;
  const load = getEncoderLoad();
  const healthy = fps >= 27 && late === 0;
  el.style.color = healthy ? '#9f9' : (fps >= 20 ? '#fd6' : '#f99');
  const encNames = [];
  if (mediaRecorder && mediaRecorder.state === 'recording') encNames.push('REC');
  if (relayStreaming) encNames.push('LIVE');
  if (isReplayBufferOn()) encNames.push('BUF');
  el.textContent =
    `${OUTPUT_W}×${OUTPUT_H} · ${fps} fps rendu` +
    (late ? ` · ${late} retard` : '') +
    `\nencodeurs: ${load}${encNames.length ? ' (' + encNames.join('+') + ')' : ''}`;
}

// Boucle au premier plan : fluide, calée sur le compositeur.
function renderFrame() {
  renderTick();
  requestAnimationFrame(renderFrame);
}

// Boucle de secours en arrière-plan. Chrome gèle requestAnimationFrame à ~1 Hz quand
// l'onglet n'est pas visible : le canvas ne serait plus repeint, donc captureStream()
// — et avec lui le projecteur, la TV, l'enregistrement et la diffusion RTMP — se
// figerait. Un onglet qui joue du son (keepAlive) est en revanche exempté du throttling
// des timers, donc ce setInterval continue à ~30 fps et maintient le canvas vivant.
// Le check document.hidden laisse rAF gérer le premier plan (pas de double dessin).
let bgRenderTimer = null;
let bgRenderWorker = null;
function startBgRenderLoop() {
  if (bgRenderTimer) return;
  // 1) Timer de secours classique. Utile, mais le thread principal peut être
  //    throttlé à ~1 Hz (voire 1/min après 5 min) quand l'onglet est en fond.
  bgRenderTimer = setInterval(() => {
    if (document.hidden) renderTick();
  }, RENDER_INTERVAL_MS);
  // 2) Tick porté par un Web Worker. Les timers d'un worker ne subissent pas le
  //    throttling agressif des onglets en arrière-plan : il réveille le rendu du
  //    thread principal à ~30 fps même studio en fond, pour que la diffusion
  //    (et le défilement de l'annonce) ne ralentisse pas. Repli sur le setInterval
  //    ci-dessus si les workers ne sont pas disponibles. renderTick() est calé en
  //    temps (grille 30 fps) → pas de double dessin si plusieurs sources tiquent.
  try {
    const src = 'var h=null;onmessage=function(e){var ms=(e.data&&e.data.ms)||33;if(h)clearInterval(h);h=setInterval(function(){postMessage(1);},ms);};';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    bgRenderWorker = new Worker(url);
    bgRenderWorker.onmessage = () => { if (document.hidden) renderTick(); };
    bgRenderWorker.postMessage({ ms: RENDER_INTERVAL_MS });
  } catch (e) { /* worker indispo : le setInterval assure le repli */ }
}

// ============ Moteur de transitions ============
// Easing cosinusoïdal — démarre/finit doucement, plus naturel à l'œil que le linéaire.
function easeInOut(t) { return 0.5 - 0.5 * Math.cos(Math.PI * t); }

function applyTransition(kind, t, oldScene, newScene) {
  const w = OUTPUT_W, h = OUTPUT_H;
  const e = easeInOut(t);

  switch (kind) {
    case 'fade': {
      drawScene(oldScene);
      ctx.globalAlpha = e;
      drawScene(newScene);
      ctx.globalAlpha = 1;
      return;
    }
    case 'fade-black': {
      // Phase 1 (0 → 0.5) : ancien → noir.  Phase 2 (0.5 → 1) : noir → nouveau.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      if (t < 0.5) {
        ctx.globalAlpha = 1 - easeInOut(t * 2);
        drawScene(oldScene);
      } else {
        ctx.globalAlpha = easeInOut((t - 0.5) * 2);
        drawScene(newScene);
      }
      ctx.globalAlpha = 1;
      return;
    }
    case 'fade-white': {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      if (t < 0.5) {
        ctx.globalAlpha = 1 - easeInOut(t * 2);
        drawScene(oldScene);
      } else {
        ctx.globalAlpha = easeInOut((t - 0.5) * 2);
        drawScene(newScene);
      }
      ctx.globalAlpha = 1;
      return;
    }
    case 'slide': {
      // L'ancienne sort vers la gauche, la nouvelle entre depuis la droite.
      ctx.save();
      ctx.translate(-e * w, 0);
      drawScene(oldScene);
      ctx.restore();
      ctx.save();
      ctx.translate((1 - e) * w, 0);
      drawScene(newScene);
      ctx.restore();
      return;
    }
    case 'zoom': {
      // L'ancienne s'estompe en s'agrandissant légèrement, la nouvelle apparaît en grandissant depuis 70%.
      // Ancien : scale 1 → 1.15, alpha 1 → 0
      const oldScale = 1 + 0.15 * e;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(oldScale, oldScale);
      ctx.translate(-w / 2, -h / 2);
      ctx.globalAlpha = 1 - e;
      drawScene(oldScene);
      ctx.restore();
      // Nouveau : scale 0.7 → 1, alpha 0 → 1
      const newScale = 0.7 + 0.3 * e;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(newScale, newScale);
      ctx.translate(-w / 2, -h / 2);
      ctx.globalAlpha = e;
      drawScene(newScene);
      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }
    default: {
      // 'cut' ne devrait pas arriver ici (transDur=0), mais au cas où
      drawScene(newScene);
      return;
    }
  }
}

// Zones sûres EBU R 95 : on n'écrit pas sur le canvas (sinon le stream/projo
// embarquerait les guides). On utilise un overlay CSS positionné par-dessus le
// canvas dans l'UI uniquement. Voir studio.html / style.css.
const SAFE_ZONES_KEY = 'versetlive:safe-zones';
let safeZonesOn = localStorage.getItem(SAFE_ZONES_KEY) === '1';

function setSafeZones(on) {
  safeZonesOn = !!on;
  try { localStorage.setItem(SAFE_ZONES_KEY, safeZonesOn ? '1' : '0'); } catch (e) {}
  document.body.classList.toggle('safe-zones-on', safeZonesOn);
  const btn = $('safeZonesBtn');
  if (btn) btn.classList.toggle('active', safeZonesOn);
}

// ============ Multiview : grille d'aperçus live des scènes ============
// Rend chaque scène sur un mini-canvas (480×270) en réutilisant drawScene via
// un scale 2D. Tourne à 5 fps pour rester léger (12 minis × 5 fps = 60 redraw/s).
const MULTIVIEW_KEY = 'versetlive:multiview';
const MULTIVIEW_MAX = 12;
const MULTIVIEW_FPS = 5;
let multiviewOn = localStorage.getItem(MULTIVIEW_KEY) === '1';
let multiviewTimer = null;
let multiviewLastSig = '';

function setMultiview(on) {
  multiviewOn = !!on;
  try { localStorage.setItem(MULTIVIEW_KEY, multiviewOn ? '1' : '0'); } catch (e) {}
  const container = $('multiviewContainer');
  const btn = $('multiviewBtn');
  if (container) container.hidden = !multiviewOn;
  if (btn) btn.classList.toggle('active', multiviewOn);
  if (multiviewOn) startMultiview(); else stopMultiview();
}

// Allège le multiview quand plusieurs encodeurs tournent en parallèle (record + stream +
// replay buffer = 3 pass d'encodage du canvas). Garder 5 fps pendant ces moments
// saturait le CPU sur Mac modeste, d'où le freeze observé pendant le filmage.
function getMultiviewIntervalMs() {
  const load = getEncoderLoad();
  if (load >= 3) return 1000; // 1 fps
  if (load >= 2) return 500;  // 2 fps
  if (load >= 1) return 333;  // 3 fps
  return Math.round(1000 / MULTIVIEW_FPS); // 5 fps par défaut
}

function startMultiview() {
  rebuildMultiviewGrid();
  if (multiviewTimer) { clearTimeout(multiviewTimer); multiviewTimer = null; }
  const tick = () => {
    if (!multiviewOn) return;
    try { renderMultiviewFrame(); } catch (e) {}
    multiviewTimer = setTimeout(tick, getMultiviewIntervalMs());
  };
  tick();
}

function stopMultiview() {
  if (multiviewTimer) { clearTimeout(multiviewTimer); multiviewTimer = null; }
}

// Reconstruit la grille seulement quand la liste de scènes change (signature simple).
function rebuildMultiviewGrid() {
  const grid = $('multiviewGrid');
  if (!grid) return;
  const scenes = buildSceneList().slice(0, MULTIVIEW_MAX);
  const sig = scenes.map(s => s.key).join('|');
  if (sig === multiviewLastSig && grid.children.length === scenes.length) return;
  multiviewLastSig = sig;
  grid.innerHTML = '';
  scenes.forEach((sc, i) => {
    const cell = document.createElement('div');
    cell.className = 'studio-multiview-cell';
    cell.dataset.idx = i;
    cell.innerHTML = `
      <canvas width="480" height="270"></canvas>
      <div class="studio-multiview-tag">${i + 1}</div>
      <div class="studio-multiview-label">${escapeHtml(sc.label)}</div>
    `;
    cell.addEventListener('click', () => {
      const list = buildSceneList();
      const item = list[i];
      const target = item && item.scene;
      if (!target) return;
      // Double-clic : envoie directement au direct (programme), sans passer par le preview.
      if (isSceneDoubleClick(item.key)) setProgramScene(target);
      else if (studioMode) setPreviewScene(target);
      else setScene(target);
    });
    grid.appendChild(cell);
  });
}

function renderMultiviewFrame() {
  if (!multiviewOn) return;
  rebuildMultiviewGrid();
  const grid = $('multiviewGrid');
  if (!grid) return;
  const scenes = buildSceneList().slice(0, MULTIVIEW_MAX);
  const prevActive = activeCtx;
  const programKey = sceneKey(programScene);
  const previewKey = sceneKey(previewScene);
  for (let i = 0; i < scenes.length; i++) {
    const cell = grid.children[i];
    if (!cell) continue;
    const canvas = cell.querySelector('canvas');
    if (!canvas) continue;
    const c = canvas.getContext('2d');
    c.save();
    c.fillStyle = '#000';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.scale(canvas.width / OUTPUT_W, canvas.height / OUTPUT_H);
    activeCtx = c;
    try { drawScene(scenes[i].scene); } catch (e) {}
    c.restore();
    cell.classList.toggle('program', scenes[i].key === programKey);
    cell.classList.toggle('preview', studioMode && scenes[i].key === previewKey && scenes[i].key !== programKey);
  }
  activeCtx = prevActive;
}

function updateProgramInfo() {
  const info = $('programInfo');
  const label = sources.length
    ? `${sources.length} caméra${sources.length > 1 ? 's' : ''}`
    : 'Aucune caméra';
  info.textContent = `${OUTPUT_W}×${OUTPUT_H} · ${OUTPUT_FPS} fps · ${label}`;
}

// ============ Audio ============
async function setMicrophone(deviceId) {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  micDeviceId = deviceId;
  if (!deviceId) {
    rebuildAudioGraph();
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
      video: false
    });
    rebuildAudioGraph();
    toast('Micro activé');
  } catch (e) {
    toast('Impossible d\'ouvrir le micro : ' + e.message, true);
  }
}

function rebuildAudioGraph() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  if (audioDest) try { audioDest.disconnect(); } catch (e) {}
  audioDest = audioCtx.createMediaStreamDestination();
  programAudioStream = audioDest.stream;
  // Exposé pour intro-outro.js (audio MP3 de fond mixé dans le programme)
  window.__studioAudio = { audioCtx, audioDest };

  if (micStream) {
    const src = audioCtx.createMediaStreamSource(micStream);
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = parseInt($('micGain').value, 10) / 100;
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    src.connect(micGainNode);
    micGainNode.connect(audioDest);
    micGainNode.connect(micAnalyser);
  }

  // Reconstruire le programStream si déjà capturé
  rebuildProgramStream();
}

function startAudioMeter() {
  const bar = $('audioMeter');
  const data = new Uint8Array(128);
  function loop() {
    if (micAnalyser) {
      micAnalyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const pct = Math.min(100, Math.round((avg / 255) * 200));
      bar.style.width = pct + '%';
      bar.classList.toggle('hot', pct > 85);
    } else {
      bar.style.width = '0%';
    }
    requestAnimationFrame(loop);
  }
  loop();
}

// ============ Capture du programme ============
// La piste vidéo du canvas est capturée UNE seule fois et réutilisée à chaque
// rebuild — sinon chaque toggle audio/record/stream pousserait un nouveau
// srcObject à la fenêtre projecteur, donnant l'impression que la projection
// « relance ». Avec une piste vidéo stable, le projecteur reste continu et
// l'opérateur peut basculer les scènes/affichages depuis le studio sans saut.
let programVideoTrack = null;
function rebuildProgramStream() {
  if (!programVideoTrack || programVideoTrack.readyState === 'ended') {
    // Échantillonnage natif à 30 fps : mesuré plus bas en latence que
    // captureStream(0)+requestFrame (testé), et chemin éprouvé.
    programVideoTrack = programCanvas.captureStream(OUTPUT_FPS).getVideoTracks()[0];
  }
  if (!programStream) programStream = new MediaStream();

  // Sync piste vidéo (stable)
  const existingVideo = programStream.getVideoTracks()[0];
  if (existingVideo !== programVideoTrack) {
    if (existingVideo) programStream.removeTrack(existingVideo);
    programStream.addTrack(programVideoTrack);
  }
  // Sync piste audio (peut changer)
  const newAudio = programAudioStream ? programAudioStream.getAudioTracks()[0] || null : null;
  const currentAudio = programStream.getAudioTracks()[0] || null;
  if (newAudio !== currentAudio) {
    if (currentAudio) programStream.removeTrack(currentAudio);
    if (newAudio) programStream.addTrack(newAudio);
  }

  // Si la fenêtre projecteur est ouverte, lui pousser le stream (no-op si déjà attaché)
  if (outputWindow && !outputWindow.closed && outputWindow.setProgramStream) {
    outputWindow.setProgramStream(programStream);
  }

  // Si la TV reçoit la vidéo, refaire l'appel avec le nouveau stream (vidéo seule)
  if (tvMediaCall && tvPeerId && signalingPeer && !signalingPeer.disconnected) {
    try { tvMediaCall.close(); } catch (e) {}
    const videoOnly = new MediaStream(programStream.getVideoTracks());
    tvMediaCall = signalingPeer.call(tvPeerId, videoOnly);
    if (tvMediaCall) {
      tvMediaCall.on('close', () => {
        if (tvMediaCall) tvMediaCall = null;
      });
    }
  }
}

// ============ Anti-throttling : maintient le canvas vivant en arrière-plan ============
// Chrome ralentit requestAnimationFrame à ~1Hz quand l'onglet n'est pas au premier plan.
// Astuce : un onglet qui joue du son n'est pas throttlé → oscillateur quasi-inaudible.
// On y ajoute Wake Lock pour empêcher l'écran de s'endormir pendant les longs services.
let keepAliveOsc = null;
let wakeLock = null;
let keepAliveStarted = false;

function startKeepAlive() {
  if (keepAliveStarted) {
    acquireWakeLock();
    return;
  }
  keepAliveStarted = true;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (!keepAliveOsc) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.0001; // quasi inaudible
      osc.frequency.value = 1;  // sous la plage d'audition humaine
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      keepAliveOsc = osc;
    }
  } catch (e) {}
  acquireWakeLock();
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {}
}

// Le wake lock est relâché quand l'onglet passe en arrière-plan : on le ré-acquiert au retour.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && keepAliveStarted && !wakeLock) acquireWakeLock();
});

// ============ Projecteur ============
// Callback appelé par studio-output.html quand il détecte le ratio du projecteur
// (au démarrage, au resize, au passage plein écran).
let lastProjectorAspect = null;
window.onProjectorAspectChange = function (info) {
  if (!info) return;
  lastProjectorAspect = info;
  const label = info.standard ? info.name : (info.name + ' approx.');
  toast(`Projecteur ${info.w}×${info.h} · ${label} détecté`);
  if (info.name !== '16:9') {
    // Avertit subtilement si le projecteur n'est pas en 16:9 — le canvas reste 16:9
    // mais les bandes de letterbox seront en bleu nuit AD (pas noir pur).
    console.info(`[VersetLive] Projecteur non-16:9 (${info.name}) — letterbox AD navy activé.`);
  }
};

function openProjector() {
  if (!programStream) rebuildProgramStream();
  startKeepAlive();
  if (outputWindow && !outputWindow.closed) {
    outputWindow.focus();
    return;
  }
  outputWindow = window.open('studio-output.html', 'versetlive-studio-output',
    'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no');
  if (!outputWindow) {
    toast('Le navigateur a bloqué l\'ouverture de la fenêtre. Autorise les pop-ups.', true);
    return;
  }
  const tryAttach = () => {
    if (outputWindow.setProgramStream) {
      outputWindow.setProgramStream(programStream);
      // Si la scène courante est un iframe (YouTube/Vimeo), réémet l'URL.
      if (programScene.kind === 'iframe' && outputWindow.setIframeUrl) {
        outputWindow.setIframeUrl(programScene.url);
      }
      toast('Fenêtre projecteur ouverte — glisse-la sur l\'écran du projecteur puis F11');
    } else {
      setTimeout(tryAttach, 100);
    }
  };
  tryAttach();
  updateHdmiOutputUi();
  // Surveiller la fermeture (l'utilisateur peut fermer la fenêtre depuis macOS)
  const watch = setInterval(() => {
    if (!outputWindow || outputWindow.closed) {
      clearInterval(watch);
      outputWindow = null;
      updateHdmiOutputUi();
    }
  }, 1000);
}

function closeProjector() {
  if (outputWindow && !outputWindow.closed) {
    try { outputWindow.close(); } catch (e) {}
  }
  outputWindow = null;
  updateHdmiOutputUi();
  toast('Fenêtre projecteur fermée');
}

function updateHdmiOutputUi() {
  const open = !!(outputWindow && !outputWindow.closed);
  const card = $('outputHdmiCard');
  if (card) card.classList.toggle('connected', open);
  const status = $('outputHdmiStatus');
  if (status) status.textContent = open ? '✓ Fenêtre ouverte — drag sur l\'écran projecteur + F11' : 'Fenêtre fermée';
  const openBtn = $('outputHdmiOpen');
  const closeBtn = $('outputHdmiClose');
  if (openBtn) openBtn.hidden = open;
  if (closeBtn) closeBtn.hidden = !open;
}

function bindOutputsPanel() {
  const tvConnect = $('outputTvConnect');
  if (tvConnect) tvConnect.addEventListener('click', () => $('tvModal').classList.add('show'));
  const tvDisconnect = $('outputTvDisconnect');
  if (tvDisconnect) tvDisconnect.addEventListener('click', () => disconnectFromTv(false));
  const hdmiOpen = $('outputHdmiOpen');
  if (hdmiOpen) hdmiOpen.addEventListener('click', openProjector);
  const hdmiClose = $('outputHdmiClose');
  if (hdmiClose) hdmiClose.addEventListener('click', closeProjector);
  updateHdmiOutputUi();
}

// ============ Sélecteur qualité (720p / 1080p) ============
function applyQualityToCanvases() {
  const preset = QUALITY_PRESETS[currentQuality];
  OUTPUT_W = preset.w;
  OUTPUT_H = preset.h;
  if (programCanvas) {
    programCanvas.width = preset.w;
    programCanvas.height = preset.h;
  }
  const previewCanvas = $('previewCanvas');
  if (previewCanvas) {
    previewCanvas.width = preset.w;
    previewCanvas.height = preset.h;
  }
}

function setQuality(quality) {
  if (!QUALITY_PRESETS[quality] || quality === currentQuality) return;
  // Sécurité direct : changer de qualité reconstruit la piste vidéo du programme
  // (stop + recapture). Les MediaRecorder déjà lancés (enregistrement, stream
  // YouTube, replay) restent accrochés à l'ancienne piste → leur vidéo se FIGE.
  // On bloque donc en plein direct, sauf confirmation explicite de l'opérateur.
  const liveStreaming = !!relayStreaming;
  const liveRecording = !!(mediaRecorder && mediaRecorder.state === 'recording');
  const liveReplay = !!replayBufferRecorder;
  if (liveStreaming || liveRecording || liveReplay) {
    const actifs = [
      liveStreaming ? 'la diffusion en direct' : null,
      liveRecording ? 'l\'enregistrement' : null,
      liveReplay ? 'le replay' : null,
    ].filter(Boolean).join(' et ');
    const phrase = actifs.charAt(0).toUpperCase() + actifs.slice(1);
    const ok = confirm(
      `⚠ ${phrase} en cours.\n\n` +
      `Changer la qualité maintenant va FIGER la vidéo envoyée (image gelée) ` +
      `tant que tu n'auras pas redémarré ${liveStreaming ? 'la diffusion' : 'l\'enregistrement'}.\n\n` +
      `À ne faire qu'entre deux cultes. Continuer quand même ?`
    );
    if (!ok) {
      // Annulé : on remet le sélecteur sur la qualité réellement active.
      const sel = $('qualitySelect');
      if (sel) sel.value = currentQuality;
      return;
    }
  }
  currentQuality = quality;
  localStorage.setItem(QUALITY_KEY, quality);
  applyQualityToCanvases();
  // Force la reconstruction de la piste vidéo captureStream — l'ancienne
  // garde son ancienne résolution figée.
  if (programVideoTrack) {
    try { programVideoTrack.stop(); } catch (e) {}
    programVideoTrack = null;
  }
  rebuildProgramStream();
  updateProgramInfo();
  const preset = QUALITY_PRESETS[quality];
  toast(`Qualité : ${preset.w}×${preset.h} · stream ${(preset.streamBitrate/1_000_000).toFixed(1)} Mbps`);
  if (relayStreaming) toast('Note : le live en cours garde son bitrate. Redémarre la diffusion pour appliquer.', false);
}

function bindQualitySelector() {
  const sel = $('qualitySelect');
  if (sel) {
    sel.value = currentQuality;
    sel.addEventListener('change', (e) => setQuality(e.target.value));
  }
  // Sync les canvas avec la qualité sauvegardée en localStorage.
  applyQualityToCanvases();

  // Zones sûres EBU R 95 (overlay UI only)
  const sz = $('safeZonesBtn');
  if (sz) {
    setSafeZones(safeZonesOn); // applique l'état initial à la classe body
    sz.addEventListener('click', () => setSafeZones(!safeZonesOn));
  }

  // Multiview (toggleable)
  const mv = $('multiviewBtn');
  if (mv) {
    setMultiview(multiviewOn); // applique l'état initial
    mv.addEventListener('click', () => setMultiview(!multiviewOn));
  }
  const mvClose = $('multiviewCloseBtn');
  if (mvClose) mvClose.addEventListener('click', () => setMultiview(false));

  // Paramètres avancés (bitrate + nom fichier)
  bindSettingsModal();
}

function bindSettingsModal() {
  const openBtn = $('openSettingsBtn');
  const modal = $('settingsModal');
  if (!openBtn || !modal) return;
  openBtn.addEventListener('click', () => { refreshSettingsModal(); modal.classList.add('show'); });
  $('settingsModalClose')?.addEventListener('click', () => modal.classList.remove('show'));
  $('settingsModalOk')?.addEventListener('click', () => modal.classList.remove('show'));

  const bSel = $('bitrateModeSelect');
  if (bSel) {
    bSel.value = bitrateMode;
    bSel.addEventListener('change', (e) => {
      setBitrateMode(e.target.value);
      refreshSettingsModal();
    });
  }
  // ===== Réglages performance / latence =====
  const cbSmooth = $('perfSmoothPriority');
  if (cbSmooth) {
    cbSmooth.checked = smoothPriorityOn;
    cbSmooth.addEventListener('change', (e) => {
      smoothPriorityOn = e.target.checked;
      localStorage.setItem(SMOOTH_PRIORITY_KEY, smoothPriorityOn ? '1' : '0');
    });
  }
  const cbAutoRes = $('perfAutoRes');
  if (cbAutoRes) {
    cbAutoRes.checked = autoResOn;
    cbAutoRes.addEventListener('change', (e) => {
      autoResOn = e.target.checked;
      localStorage.setItem(AUTO_RES_KEY, autoResOn ? '1' : '0');
      maybeAutoResolution();
    });
  }
  const cbHud = $('perfHudToggle');
  if (cbHud) {
    cbHud.checked = perfHudOn;
    cbHud.addEventListener('change', (e) => {
      perfHudOn = e.target.checked;
      localStorage.setItem(PERF_HUD_KEY, perfHudOn ? '1' : '0');
      const el = document.getElementById('perfHud');
      if (el) el.hidden = !perfHudOn;
    });
  }

  const nameInp = $('recordNameInput');
  if (nameInp) {
    nameInp.value = recordNamePattern;
    nameInp.addEventListener('input', (e) => { setRecordNamePattern(e.target.value); refreshSettingsModal(); });
  }
  const titleInp = $('recordTitleInput');
  if (titleInp) {
    titleInp.value = recordTitle;
    titleInp.addEventListener('input', (e) => { setRecordTitle(e.target.value); refreshSettingsModal(); });
  }

  // Replay buffer
  const rbToggle = $('replayBufferToggle');
  if (rbToggle) rbToggle.addEventListener('click', () => {
    if (isReplayBufferOn()) stopReplayBuffer(); else startReplayBuffer();
  });
  const rbSave = $('replayBufferSave');
  if (rbSave) rbSave.addEventListener('click', () => saveReplayBuffer());
  const rbDur = $('replayBufferDuration');
  if (rbDur) {
    rbDur.value = String(replayBufferMaxSeconds);
    rbDur.addEventListener('change', (e) => setReplayBufferMaxSeconds(e.target.value));
  }
  updateReplayBufferUi();
}

function refreshSettingsModal() {
  const info = $('bitrateModeInfo');
  if (info) {
    const v = Math.round(streamBitrate() / 1000);
    const r = Math.round(recordBitrate() / 1000);
    const a = Math.round(audioBitrate() / 1000);
    info.textContent = `Stream : ${v} kbps · Record : ${r} kbps · Audio : ${a} kbps (qualité ${currentQuality})`;
  }
  const prev = $('recordNamePreview');
  if (prev) prev.textContent = 'Aperçu : ' + resolveRecordName() + '.webm';
}

// ============ Bitrate (preset Économique / Standard / Haute qualité) ============
// Multiplie les valeurs de QUALITY_PRESETS pour adapter à la bande passante
// disponible. Appliqué au prochain démarrage de record / stream.
const BITRATE_MODE_KEY = 'versetlive:bitrate-mode';
const BITRATE_MODES = {
  eco:  { label: '⚡ Économique',  mul: 0.6, audio: 96_000 },
  std:  { label: '⚖️ Standard',    mul: 1.0, audio: 128_000 },
  high: { label: '✨ Haute qualité', mul: 1.7, audio: 192_000 },
};
let bitrateMode = BITRATE_MODES[localStorage.getItem(BITRATE_MODE_KEY)] ? localStorage.getItem(BITRATE_MODE_KEY) : 'std';
function setBitrateMode(mode) {
  if (!BITRATE_MODES[mode]) return;
  bitrateMode = mode;
  try { localStorage.setItem(BITRATE_MODE_KEY, mode); } catch (e) {}
  toast(`Bitrate : ${BITRATE_MODES[mode].label} (effet au prochain démarrage du stream/record)`);
}
function streamBitrate() { return Math.round(QUALITY_PRESETS[currentQuality].streamBitrate * BITRATE_MODES[bitrateMode].mul); }
function recordBitrate() { return Math.round(QUALITY_PRESETS[currentQuality].recordBitrate * BITRATE_MODES[bitrateMode].mul); }
function audioBitrate()  { return BITRATE_MODES[bitrateMode].audio; }

// ============ Nom de fichier d'enregistrement (pattern utilisateur) ============
// Tokens supportés : {date} = YYYY-MM-DD, {time} = HH-mm, {title} = champ libre.
const RECORD_NAME_KEY = 'versetlive:record-name';
const RECORD_TITLE_KEY = 'versetlive:record-title';
const RECORD_NAME_DEFAULT = 'versetlive-{date}-{time}';
let recordNamePattern = localStorage.getItem(RECORD_NAME_KEY) || RECORD_NAME_DEFAULT;
let recordTitle = localStorage.getItem(RECORD_TITLE_KEY) || '';
function setRecordNamePattern(p) { recordNamePattern = p || RECORD_NAME_DEFAULT; try { localStorage.setItem(RECORD_NAME_KEY, recordNamePattern); } catch (e) {} }
function setRecordTitle(t) { recordTitle = (t || '').trim(); try { localStorage.setItem(RECORD_TITLE_KEY, recordTitle); } catch (e) {} }
function resolveRecordName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const tokens = {
    '{date}': `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    '{time}': `${pad(d.getHours())}-${pad(d.getMinutes())}`,
    '{title}': (recordTitle || 'service').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-'),
  };
  let name = recordNamePattern;
  for (const [k, v] of Object.entries(tokens)) name = name.split(k).join(v);
  // Nettoyage : caractères interdits dans les noms de fichier
  return name.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 120) || 'versetlive';
}

// ============ Replay buffer (ring buffer des N dernières secondes) ============
// On garde le tout premier chunk (header EBML + tracks + segment info de webm) +
// une fenêtre glissante des N derniers chunks (timeslice = 1 s → 1 chunk/s).
// Précédemment on accumulait sans limite : ~6 Mbps × heures = plusieurs Go de RAM,
// donc freeze du navigateur en service long. Le ring buffer cap la RAM à
// ~recordBitrate × replayBufferMaxSeconds (≈ 45 Mo pour 60 s à 6 Mbps).
const REPLAY_BUFFER_KEY = 'versetlive:replay-buffer-seconds';
const REPLAY_BUFFER_MIN_S = 15;
const REPLAY_BUFFER_MAX_S = 600;
let replayBufferRecorder = null;
let replayBufferHeader = null;     // tout premier chunk (init EBML)
let replayBufferRecent = [];       // fenêtre glissante des N derniers chunks
let replayBufferStartedAt = 0;
let replayBufferMaxSeconds = (function () {
  const raw = parseInt(localStorage.getItem(REPLAY_BUFFER_KEY), 10);
  if (!Number.isFinite(raw)) return 60;
  return Math.max(REPLAY_BUFFER_MIN_S, Math.min(REPLAY_BUFFER_MAX_S, raw));
})();

function setReplayBufferMaxSeconds(s) {
  const v = Math.max(REPLAY_BUFFER_MIN_S, Math.min(REPLAY_BUFFER_MAX_S, parseInt(s, 10) || 60));
  replayBufferMaxSeconds = v;
  try { localStorage.setItem(REPLAY_BUFFER_KEY, String(v)); } catch (e) {}
  trimReplayBuffer();
  updateReplayBufferUi();
}

function trimReplayBuffer() {
  while (replayBufferRecent.length > replayBufferMaxSeconds) {
    replayBufferRecent.shift();
  }
}

function isReplayBufferOn() {
  return !!(replayBufferRecorder && replayBufferRecorder.state === 'recording');
}

function startReplayBuffer() {
  if (isReplayBufferOn()) return;
  if (!programStream) rebuildProgramStream();
  startKeepAlive(); // garde le canvas vivant en arrière-plan (sinon le replay buffer fige les frames)

  // Avertir si on cumule 3 encodeurs MediaRecorder en parallèle (record + stream + replay).
  // Chaque encodeur = un pass d'encodage vidéo sur le canvas 1080p. Sur Mac modeste ça
  // sature le CPU et cause du freeze pendant le filmage.
  const recordingOn = !!(mediaRecorder && mediaRecorder.state === 'recording');
  if (recordingOn && relayStreaming) {
    toast('⚠ Record + Stream + Replay = 3 encodeurs. Si ça lague, coupe le multiview ou baisse la qualité.', false);
  }

  const mime = pickMime();
  try {
    replayBufferRecorder = new MediaRecorder(programStream, {
      mimeType: mime,
      videoBitsPerSecond: recordBitrate(),
      audioBitsPerSecond: audioBitrate(),
    });
  } catch (e) {
    toast('Replay buffer : ' + e.message, true);
    return;
  }
  replayBufferHeader = null;
  replayBufferRecent = [];
  replayBufferStartedAt = Date.now();
  replayBufferRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    if (!replayBufferHeader) replayBufferHeader = e.data;
    else { replayBufferRecent.push(e.data); trimReplayBuffer(); }
  };
  replayBufferRecorder.start(1000);
  updateReplayBufferUi();
  toast(`📼 Replay buffer actif (fenêtre glissante de ${replayBufferMaxSeconds} s)`);
}

function stopReplayBuffer() {
  if (!replayBufferRecorder) return;
  try { if (replayBufferRecorder.state === 'recording') replayBufferRecorder.stop(); } catch (e) {}
  replayBufferRecorder = null;
  replayBufferHeader = null;
  replayBufferRecent = [];
  replayBufferStartedAt = 0;
  updateReplayBufferUi();
}

// Force le flush du dernier chunk → concat (header + chunks récents) → télécharge → redémarre.
async function saveReplayBuffer() {
  if (!isReplayBufferOn()) { toast('Le replay buffer n\'est pas actif', true); return; }
  const mime = replayBufferRecorder.mimeType || pickMime();
  const done = new Promise(res => { replayBufferRecorder.onstop = res; });
  try { replayBufferRecorder.stop(); } catch (e) {}
  await done;
  const parts = [];
  if (replayBufferHeader) parts.push(replayBufferHeader);
  parts.push(...replayBufferRecent);
  const blob = new Blob(parts, { type: mime });
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  // Durée effective = nombre de chunks récents (≈ 1 chunk/s)
  const dur = replayBufferRecent.length;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resolveRecordName()}-replay-${dur}s.${ext}`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  if (window.VideoLibrary) {
    const niceName = `Replay ${dur}s ${new Date().toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    window.VideoLibrary.addRecording(blob, niceName).catch(err => console.warn('save replay to lib failed', err));
  }
  toast(`📼 Replay ${dur}s sauvé`);
  replayBufferRecorder = null;
  replayBufferHeader = null;
  replayBufferRecent = [];
  startReplayBuffer();
}

function updateReplayBufferUi() {
  const btn = $('replayBufferToggle');
  const saveBtn = $('replayBufferSave');
  const info = $('replayBufferInfo');
  const durInp = $('replayBufferDuration');
  if (btn) btn.textContent = isReplayBufferOn() ? '⏹ Arrêter le buffer' : '📼 Activer le buffer';
  if (saveBtn) saveBtn.disabled = !isReplayBufferOn();
  if (durInp && document.activeElement !== durInp) durInp.value = String(replayBufferMaxSeconds);
  if (info) {
    if (isReplayBufferOn()) {
      const recentSec = replayBufferRecent.length;
      const allBytes = ((replayBufferHeader && replayBufferHeader.size) || 0)
        + replayBufferRecent.reduce((acc, b) => acc + b.size, 0);
      const mo = (allBytes / 1024 / 1024).toFixed(1);
      info.textContent = `Fenêtre ${recentSec}/${replayBufferMaxSeconds} s · ${mo} Mo en RAM`;
    } else {
      info.textContent = `Buffer désactivé. Conservera les ${replayBufferMaxSeconds} dernières secondes une fois activé.`;
    }
  }
}

// Met à jour l'info en RAM toutes les secondes quand le buffer tourne.
setInterval(() => { if (isReplayBufferOn()) updateReplayBufferUi(); }, 1000);

// ============ Enregistrement ============
function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (!programStream) rebuildProgramStream();
  startKeepAlive(); // garde le canvas vivant en arrière-plan (sinon l'enregistrement gèle)

  recordedChunks = [];
  const mime = pickMime();
  try {
    mediaRecorder = new MediaRecorder(programStream, {
      mimeType: mime,
      videoBitsPerSecond: recordBitrate(),
      audioBitsPerSecond: audioBitrate(),
    });
  } catch (e) {
    toast('MediaRecorder non supporté : ' + e.message, true);
    return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    a.href = url;
    a.download = `${resolveRecordName()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    // Sauvegarder aussi dans la vidéothèque locale (en plus du téléchargement)
    if (window.VideoLibrary) {
      const niceName = `Enregistrement ${new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
      window.VideoLibrary.addRecording(blob, niceName).catch(err => console.warn('save recording to lib failed', err));
    }
    updateRecordBtn(false);
    setStatus('Prêt');
    toast('Enregistrement sauvegardé');
  };
  mediaRecorder.start(1000);
  updateRecordBtn(true);
  setStatus('● Enregistrement');
  toast('Enregistrement démarré');
}

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function updateRecordBtn(recording) {
  const btn = $('recordBtn');
  btn.textContent = recording ? '⏹ Arrêter l\'enreg.' : '⏺ Enregistrer';
  btn.classList.toggle('btn-danger', !recording);
  btn.classList.toggle('btn-success', recording);
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

function setStatus(s) { $('studioStatus').textContent = s; }

// ============ Synchro verset ============
function applyVerseState(state) {
  verseState = state;
  if (typeof coopBroadcast === 'function') coopBroadcast();
  renderVerseStatus();
  renderSongStatus();
  syncStudioSceneScaleUI();
  syncStudioFontSizeUI();
  syncStudioSceneOffsetUI();
  if (state && state.reference && state.kind !== 'song') syncBookChapterSelectsFromRef(state.reference);
}

// ===== Réduction du bloc verset (image + texte) depuis le studio =====
// Le curseur modifie verseState.style.sceneScale : le canvas le lit à chaque
// frame (sortie projetée), et on rediffuse le style aux autres surfaces
// (obs/tv via BroadcastChannel + TV PeerJS) pour rester synchro avec le panneau.
function setStudioSceneScale(v) {
  const scale = Math.max(0.1, Math.min(1, parseFloat(v)));
  const style = { ...(verseState?.style || {}), sceneScale: scale };
  const newState = { ...(verseState || {}), style };
  verseBc?.postMessage({ type: 'style', payload: style });
  sendToTv({ type: 'style', payload: style });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(newState)); } catch (e) {}
  applyVerseState(newState);
}

function syncStudioSceneScaleUI() {
  const slider = document.getElementById('studioSceneScale');
  if (!slider) return;
  const val = document.getElementById('studioSceneScaleVal');
  // Ne pas écraser la valeur pendant que l'utilisateur fait glisser le curseur.
  if (document.activeElement === slider) return;
  const s = verseState && verseState.style ? verseState.style.sceneScale : null;
  const scale = (s != null) ? Math.max(0.1, Math.min(1, s)) : 1;
  slider.value = scale;
  if (val) val.textContent = Math.round(scale * 100) + '%';
}

// ===== Zoom du texte du verset (taille de police) depuis le studio =====
// Agit sur style.fontSize (en vw), identique au curseur du panneau → synchronisé.
function setStudioFontSize(v) {
  const fs = Math.max(2, Math.min(10, parseFloat(v) || 4.5));
  const style = { ...(verseState?.style || {}), fontSize: fs };
  const newState = { ...(verseState || {}), style };
  verseBc?.postMessage({ type: 'style', payload: style });
  sendToTv({ type: 'style', payload: style });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(newState)); } catch (e) {}
  applyVerseState(newState);
}

function syncStudioFontSizeUI() {
  const slider = document.getElementById('studioFontSize');
  if (!slider) return;
  if (document.activeElement === slider) return;
  const s = verseState && verseState.style ? verseState.style.fontSize : null;
  const fs = (s != null) ? Math.max(2, Math.min(10, s)) : 4.5;
  slider.value = fs;
  const val = document.getElementById('studioFontSizeVal');
  if (val) val.textContent = fs.toFixed(1);
}

// ===== Décalage (position) du bloc verset depuis le studio =====
// axis = 'sceneOffsetX' ou 'sceneOffsetY' ; valeur -0.5..0.5 (fraction de la zone).
function setStudioSceneOffset(axis, v) {
  const off = Math.max(-0.5, Math.min(0.5, parseFloat(v) || 0));
  const style = { ...(verseState?.style || {}), [axis]: off };
  const newState = { ...(verseState || {}), style };
  verseBc?.postMessage({ type: 'style', payload: style });
  sendToTv({ type: 'style', payload: style });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(newState)); } catch (e) {}
  applyVerseState(newState);
}

// ===== Taille des images plein écran (scènes image) depuis le studio =====
function setFullImageScale(v) {
  fullImageScale = Math.max(0.1, Math.min(1, parseFloat(v) || 1));
  try { localStorage.setItem(FULL_IMAGE_SCALE_KEY, fullImageScale); } catch (e) {}
  syncFullImageScaleUI();
}

function syncFullImageScaleUI() {
  const slider = document.getElementById('studioFullImageScale');
  if (!slider) return;
  if (document.activeElement !== slider) slider.value = fullImageScale;
  const val = document.getElementById('studioFullImageScaleVal');
  if (val) val.textContent = Math.round(fullImageScale * 100) + '%';
}

function syncStudioSceneOffsetUI() {
  [['studioSceneOffsetX', 'studioSceneOffsetXVal', 'sceneOffsetX'],
   ['studioSceneOffsetY', 'studioSceneOffsetYVal', 'sceneOffsetY'],
   ['studioBgImageOffsetX', 'studioBgImageOffsetXVal', 'bgImageOffsetX'],
   ['studioBgImageOffsetY', 'studioBgImageOffsetYVal', 'bgImageOffsetY'],
   ['studioTextOffsetX', 'studioTextOffsetXVal', 'textOffsetX'],
   ['studioTextOffsetY', 'studioTextOffsetYVal', 'textOffsetY']].forEach(([sliderId, valId, key]) => {
    const slider = document.getElementById(sliderId);
    if (!slider) return;
    if (document.activeElement === slider) return;
    const raw = verseState && verseState.style ? verseState.style[key] : null;
    const off = (raw != null) ? Math.max(-0.5, Math.min(0.5, raw)) : 0;
    slider.value = off;
    const val = document.getElementById(valId);
    if (val) val.textContent = Math.round(off * 200) + '%';
  });
}

function renderVerseStatus() {
  const el = $('verseStatus');
  if (!verseState) {
    el.innerHTML = '<div class="studio-empty">Aucun verset affiché.<br><small>Diffuse depuis l\'onglet principal.</small></div>';
    return;
  }
  // Un chant occupe le panneau dédié 🎵 plus bas — ici on signale juste.
  if (verseState.kind === 'song') {
    el.innerHTML = '<div class="studio-empty">— Chant en cours (voir panneau 🎵) —</div>';
    return;
  }
  if (verseState.kind === 'title') {
    el.innerHTML = `
      <div class="studio-verse-kind">🏷 Titre actif</div>
      <div class="studio-verse-text">${escapeHtml(verseState.title || '')}</div>
      <div class="studio-verse-ref">${escapeHtml(verseState.subtitle || '')}</div>
    `;
  } else if (verseState.text) {
    el.innerHTML = `
      <div class="studio-verse-kind">📖 Verset actif</div>
      <div class="studio-verse-text">« ${escapeHtml(verseState.text)} »</div>
      <div class="studio-verse-ref">${escapeHtml(verseState.reference || '')}</div>
    `;
  } else {
    el.innerHTML = '<div class="studio-empty">Écran effacé.</div>';
  }
}

function renderSongStatus() {
  const el = $('songStatus');
  if (!el) return;
  const prevBtn = $('prevSongSectionBtn');
  const nextBtn = $('nextSongSectionBtn');
  if (!verseState || verseState.kind !== 'song') {
    el.innerHTML = '<div class="studio-empty">Aucun chant affiché.<br><small>Tape un numéro ci-dessous ou diffuse depuis l\'onglet principal (onglet Chants).</small></div>';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }
  const idx = verseState.sectionIndex ?? 0;
  const total = verseState.totalSections ?? 0;
  const sectionLabel = verseState.sectionLabel || `Section ${idx + 1}`;
  const sectionType = verseState.sectionType || 'verse';
  const numberBadge = verseState.songNumber ? `<span class="studio-song-number">n°${escapeHtml(String(verseState.songNumber))}</span>` : '';
  el.innerHTML = `
    <div class="studio-verse-kind">🎵 Chant actif ${numberBadge}</div>
    <div class="studio-song-title">${escapeHtml(verseState.songTitle || '')}</div>
    <div class="studio-song-section">
      <span class="studio-song-section-badge type-${escapeHtml(sectionType)}">${escapeHtml(sectionLabel)}</span>
      <span class="studio-song-progress">${idx + 1} / ${total || '?'}</span>
    </div>
    <div class="studio-song-text">${escapeHtml((verseState.text || '').slice(0, 220))}${(verseState.text || '').length > 220 ? '…' : ''}</div>
  `;
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = total ? idx >= total - 1 : true;
}

// Init depuis localStorage
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) applyVerseState(JSON.parse(saved));
} catch (e) {}

// BroadcastChannel exposé au niveau module pour permettre au studio
// d'envoyer des commandes de navigation au panneau principal.
let verseBc = null;
try {
  verseBc = new BroadcastChannel(CHANNEL_NAME);
  verseBc.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'show') applyVerseState(msg.payload);
    else if (msg.type === 'showTitle') applyVerseState({ ...msg.payload, kind: 'title' });
    else if (msg.type === 'clear') applyVerseState({ style: verseState?.style });
    else if (msg.type === 'style') applyVerseState({ ...(verseState || {}), style: msg.payload });
    else if (msg.type === 'navAck' && !msg.ok) {
      const reasons = {
        'end-of-chapter': 'Dernier verset du chapitre',
        'start-of-chapter': 'Premier verset du chapitre',
        'end-of-bible': 'Fin de la Bible atteinte',
        'start-of-bible': 'Début de la Bible atteint',
        'chapter-out-of-range': 'Numéro de chapitre hors limites',
        'parse': 'Référence invalide — exemple : Jean 3:16',
        'book-not-found': 'Livre introuvable',
      };
      toast(reasons[msg.reason] || ('Navigation : ' + msg.reason), true);
    }
    else if (msg.type === 'songNavAck' && !msg.ok) {
      const reasons = {
        'no-active-song': 'Aucun chant sélectionné dans le panneau',
        'no-sections': 'Le chant n\'a aucune section',
        'end-of-song': 'Dernière section du chant',
        'start-of-song': 'Première section du chant',
        'parse': 'Numéro invalide',
        'song-not-found': 'Numéro de chant introuvable',
        'unknown-action': 'Action chant inconnue',
      };
      toast(reasons[msg.reason] || ('Chant : ' + msg.reason), true);
    }
    // Forward to TV (si connectée)
    sendToTv(msg);
  });
} catch (e) {}

// ============ Navigation versets depuis le studio ============
// Envoie une commande au panneau principal qui exécute la navigation
// (sélection verset précédent/suivant, effacement, ou diffusion d'une
// référence libre). Le panneau rediffuse ensuite via BroadcastChannel,
// ce qui met à jour le verseState du studio automatiquement.
function navigateVerseFromStudio(action, payload) {
  if (!verseBc) {
    toast('Navigation versets non supportée (BroadcastChannel)', true);
    return;
  }
  verseBc.postMessage({ type: 'nav', action, payload });
}

function bindVerseNav() {
  const prev = $('prevVerseStudioBtn');
  if (prev) prev.addEventListener('click', () => navigateVerseFromStudio('prev'));
  const next = $('nextVerseStudioBtn');
  if (next) next.addEventListener('click', () => navigateVerseFromStudio('next'));
  const clear = $('clearVerseStudioBtn');
  if (clear) clear.addEventListener('click', () => navigateVerseFromStudio('clear'));
  const input = $('verseRefInputStudio');
  const go = $('verseRefGoStudioBtn');
  const sendRef = () => {
    const ref = input?.value.trim();
    if (!ref) return;
    navigateVerseFromStudio('showRef', ref);
  };
  if (go) go.addEventListener('click', sendRef);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendRef(); }
  });
  const scale = $('studioSceneScale');
  const scaleVal = $('studioSceneScaleVal');
  if (scale) scale.addEventListener('input', () => {
    if (scaleVal) scaleVal.textContent = Math.round(parseFloat(scale.value) * 100) + '%';
    setStudioSceneScale(scale.value);
  });
  // Zoom du texte du verset (taille de police)
  const fsz = $('studioFontSize');
  const fszVal = $('studioFontSizeVal');
  if (fsz) fsz.addEventListener('input', () => {
    if (fszVal) fszVal.textContent = parseFloat(fsz.value).toFixed(1);
    setStudioFontSize(fsz.value);
  });
  const fszReset = $('studioFontSizeReset');
  if (fszReset) fszReset.addEventListener('click', () => {
    if (fsz) fsz.value = 4.5;
    if (fszVal) fszVal.textContent = '4.5';
    setStudioFontSize(4.5);
  });
  const scaleReset = $('studioSceneScaleReset');
  if (scaleReset) scaleReset.addEventListener('click', () => {
    if (scale) scale.value = 1;
    if (scaleVal) scaleVal.textContent = '100%';
    setStudioSceneScale(1);
  });
  // Curseurs de position : bloc entier, image de fond seule, texte seul.
  // setStudioSceneOffset est générique sur la clé de style.
  [['studioSceneOffsetX', 'studioSceneOffsetXVal', 'studioSceneOffsetXReset', 'sceneOffsetX'],
   ['studioSceneOffsetY', 'studioSceneOffsetYVal', 'studioSceneOffsetYReset', 'sceneOffsetY'],
   ['studioBgImageOffsetX', 'studioBgImageOffsetXVal', 'studioBgImageOffsetXReset', 'bgImageOffsetX'],
   ['studioBgImageOffsetY', 'studioBgImageOffsetYVal', 'studioBgImageOffsetYReset', 'bgImageOffsetY'],
   ['studioTextOffsetX', 'studioTextOffsetXVal', 'studioTextOffsetXReset', 'textOffsetX'],
   ['studioTextOffsetY', 'studioTextOffsetYVal', 'studioTextOffsetYReset', 'textOffsetY']].forEach(([sliderId, valId, resetId, key]) => {
    const slider = $(sliderId);
    const val = $(valId);
    if (slider) slider.addEventListener('input', () => {
      if (val) val.textContent = Math.round(parseFloat(slider.value) * 200) + '%';
      setStudioSceneOffset(key, slider.value);
    });
    const reset = $(resetId);
    if (reset) reset.addEventListener('click', () => {
      if (slider) slider.value = 0;
      if (val) val.textContent = '0%';
      setStudioSceneOffset(key, 0);
    });
  });
  // Curseur taille image plein écran
  const fullImg = $('studioFullImageScale');
  const fullImgVal = $('studioFullImageScaleVal');
  if (fullImg) fullImg.addEventListener('input', () => {
    if (fullImgVal) fullImgVal.textContent = Math.round(parseFloat(fullImg.value) * 100) + '%';
    setFullImageScale(fullImg.value);
  });
  const fullImgReset = $('studioFullImageScaleReset');
  if (fullImgReset) fullImgReset.addEventListener('click', () => {
    if (fullImg) fullImg.value = 1;
    if (fullImgVal) fullImgVal.textContent = '100%';
    setFullImageScale(1);
  });
  syncFullImageScaleUI();
  populateBookSelect();
  bindBookChapterSelectors();
}

// ============ Navigation chants depuis le studio ============
function navigateSongFromStudio(action, payload) {
  if (!verseBc) {
    toast('Navigation chants non supportée (BroadcastChannel)', true);
    return;
  }
  verseBc.postMessage({ type: 'songNav', action, payload });
}

function bindSongNav() {
  const prev = $('prevSongSectionBtn');
  if (prev) prev.addEventListener('click', () => navigateSongFromStudio('prevSection'));
  const next = $('nextSongSectionBtn');
  if (next) next.addEventListener('click', () => navigateSongFromStudio('nextSection'));
  const clear = $('clearSongStudioBtn');
  if (clear) clear.addEventListener('click', () => navigateSongFromStudio('stop'));
  const input = $('songNumberInputStudio');
  const go = $('songNumberGoStudioBtn');
  const sendNumber = () => {
    const num = input?.value.trim();
    if (!num) return;
    navigateSongFromStudio('showByNumber', num);
  };
  if (go) go.addEventListener('click', sendNumber);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendNumber(); }
  });
}

// ============ Sélecteurs livre/chapitre (delegate au panneau via nav) ============
function populateBookSelect() {
  const bookSel = $('bookSelectStudio');
  if (!bookSel || typeof BIBLE_BOOKS === 'undefined') return;
  bookSel.innerHTML = BIBLE_BOOKS.map(b => `<option value="${b.id}">${b.short} · ${b.name}</option>`).join('');
}

function populateChapterSelect(bookId) {
  const chapSel = $('chapterSelectStudio');
  if (!chapSel || typeof BIBLE_BOOKS === 'undefined') return;
  const book = BIBLE_BOOKS.find(b => b.id == bookId);
  if (!book) { chapSel.innerHTML = ''; return; }
  const current = parseInt(chapSel.value || '1', 10);
  chapSel.innerHTML = Array.from({ length: book.chapters }, (_, i) =>
    `<option value="${i + 1}">${i + 1}</option>`
  ).join('');
  if (current >= 1 && current <= book.chapters) chapSel.value = String(current);
}

function bindBookChapterSelectors() {
  const bookSel = $('bookSelectStudio');
  const chapSel = $('chapterSelectStudio');
  if (!bookSel || !chapSel) return;
  populateChapterSelect(bookSel.value);
  bookSel.addEventListener('change', () => {
    populateChapterSelect(bookSel.value);
    const book = BIBLE_BOOKS.find(b => b.id == bookSel.value);
    if (book) navigateVerseFromStudio('showRef', `${book.name} 1:1`);
  });
  chapSel.addEventListener('change', () => {
    const book = BIBLE_BOOKS.find(b => b.id == bookSel.value);
    if (book) navigateVerseFromStudio('showRef', `${book.name} ${chapSel.value}:1`);
  });
}

// Garde les selects livre/chapitre synchronisés avec la référence en cours.
// Appelé depuis applyVerseState pour refléter aussi les changements faits
// depuis le panneau ou via la nav cross-chapitre.
function syncBookChapterSelectsFromRef(reference) {
  if (!reference || typeof BIBLE_BOOKS === 'undefined') return;
  const m = String(reference).match(/^(.+?)\s+(\d+)(?::\d+)?$/);
  if (!m) return;
  const bookName = m[1].trim().toLowerCase();
  const chap = m[2];
  const book = BIBLE_BOOKS.find(b =>
    b.name.toLowerCase() === bookName ||
    b.short.toLowerCase() === bookName ||
    b.name.toLowerCase().startsWith(bookName)
  );
  if (!book) return;
  const bookSel = $('bookSelectStudio');
  const chapSel = $('chapterSelectStudio');
  if (bookSel && String(bookSel.value) !== String(book.id)) {
    bookSel.value = String(book.id);
    populateChapterSelect(book.id);
  }
  if (chapSel) chapSel.value = chap;
}

// ============ Texte libre : section rapide + modale grand format ============
// Permet de diffuser depuis le studio :
//  - 'verse'    → verset libre (référence + texte tapé à la main)
//  - 'title'    → annonce (titre + sous-titre, style centré grand)
//  - 'keypoint' → point-clé du sermon (phrase courte, sans sous-titre)
// Le payload réutilise le pipeline existant (BroadcastChannel 'show'/'showTitle')
// donc panneau / studio / TV / OBS / projecteur le rendent comme aujourd'hui.
const TEXT_STUDIO_HISTORY_KEY = 'versetlive:studio:text-history';
const TEXT_STUDIO_TEMPLATES_KEY = 'versetlive:studio:text-templates';
const TEXT_STUDIO_MAX_HISTORY = 20;
let textStudioMode = 'verse';
let textStudioModalMode = 'verse';
let textStudioHistory = [];
let textStudioTemplates = [];

function loadTextStudioStorage() {
  try { textStudioHistory = JSON.parse(localStorage.getItem(TEXT_STUDIO_HISTORY_KEY) || '[]'); } catch (e) { textStudioHistory = []; }
  try { textStudioTemplates = JSON.parse(localStorage.getItem(TEXT_STUDIO_TEMPLATES_KEY) || '[]'); } catch (e) { textStudioTemplates = []; }
}

function saveTextStudioHistory() {
  localStorage.setItem(TEXT_STUDIO_HISTORY_KEY, JSON.stringify(textStudioHistory.slice(0, TEXT_STUDIO_MAX_HISTORY)));
}
function saveTextStudioTemplates() {
  localStorage.setItem(TEXT_STUDIO_TEMPLATES_KEY, JSON.stringify(textStudioTemplates));
}

function fieldStyle() {
  return 'width:100%; padding:6px 8px; border-radius:4px; border:1px solid #444; background:#1a1a1a; color:inherit; font-size:13px; font-family:inherit; margin-bottom:6px; box-sizing:border-box;';
}

// Render des champs adaptés au mode courant dans un container donné.
// `containerId` = élément qui reçoit le HTML. `prefix` distingue les IDs
// entre la section rapide (textStudio*) et la modale (textStudioModal*).
function renderTextModeContent(containerId, prefix, mode, big) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const rowsVerse = big ? 6 : 3;
  const rowsKey = big ? 4 : 2;
  if (mode === 'verse') {
    wrap.innerHTML = `
      <input type="text" id="${prefix}VerseRef" placeholder="Référence (ex: Jean 3:16 ou Annonce)" style="${fieldStyle()}">
      <textarea id="${prefix}VerseText" rows="${rowsVerse}" placeholder="Texte du verset à diffuser..." style="${fieldStyle()}"></textarea>
    `;
  } else if (mode === 'title') {
    wrap.innerHTML = `
      <input type="text" id="${prefix}Title" placeholder="Titre principal (ex: Réunion de prière)" style="${fieldStyle()}">
      <input type="text" id="${prefix}Subtitle" placeholder="Sous-titre (optionnel — ex: Ce soir 19h)" style="${fieldStyle()}">
    `;
  } else if (mode === 'keypoint') {
    wrap.innerHTML = `
      <textarea id="${prefix}Keypoint" rows="${rowsKey}" placeholder="Phrase courte à afficher (ex: Dieu est amour)" style="${fieldStyle()}"></textarea>
    `;
  }
}

function collectTextStudioPayload(prefix, mode) {
  if (mode === 'verse') {
    const ref = document.getElementById(`${prefix}VerseRef`)?.value.trim() || '';
    const text = document.getElementById(`${prefix}VerseText`)?.value.trim() || '';
    if (!text) return { error: 'Le texte du verset est vide' };
    return {
      kind: 'verse',
      state: { reference: ref || 'Verset', text, translation: 'Manuel', style: verseState?.style || {}, ts: Date.now() },
      historyItem: { mode: 'verse', reference: ref || 'Verset', text }
    };
  }
  if (mode === 'title') {
    const title = document.getElementById(`${prefix}Title`)?.value.trim() || '';
    const subtitle = document.getElementById(`${prefix}Subtitle`)?.value.trim() || '';
    if (!title) return { error: 'Le titre est vide' };
    return {
      kind: 'title',
      state: { title, subtitle, kind: 'title', style: verseState?.style || {} },
      historyItem: { mode: 'title', title, subtitle }
    };
  }
  if (mode === 'keypoint') {
    const text = document.getElementById(`${prefix}Keypoint`)?.value.trim() || '';
    if (!text) return { error: 'Le texte est vide' };
    return {
      kind: 'title',
      state: { title: text, subtitle: '', kind: 'title', style: verseState?.style || {} },
      historyItem: { mode: 'keypoint', text }
    };
  }
  return { error: 'Mode inconnu' };
}

function diffuseTextStudioState(p) {
  if (!verseBc) { toast('BroadcastChannel non supporté', true); return false; }
  if (p.kind === 'verse') {
    verseBc.postMessage({ type: 'show', payload: p.state });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p.state));
  } else {
    verseBc.postMessage({ type: 'showTitle', payload: p.state });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p.state));
  }
  // Maj locale immédiate (sinon il faut attendre le retour storage event).
  applyVerseState(p.state);
  return true;
}

function addToTextStudioHistory(item) {
  const key = JSON.stringify({ m: item.mode, r: item.reference, t: item.title || item.text, s: item.subtitle });
  textStudioHistory = textStudioHistory.filter(h =>
    JSON.stringify({ m: h.mode, r: h.reference, t: h.title || h.text, s: h.subtitle }) !== key
  );
  textStudioHistory.unshift({ ...item, ts: Date.now() });
  textStudioHistory = textStudioHistory.slice(0, TEXT_STUDIO_MAX_HISTORY);
  saveTextStudioHistory();
}

function diffuseFromUI(prefix, mode) {
  const result = collectTextStudioPayload(prefix, mode);
  if (result.error) { toast(result.error, true); return false; }
  if (!diffuseTextStudioState(result)) return false;
  addToTextStudioHistory(result.historyItem);
  renderTextStudioHistory();
  toast('Diffusion lancée');
  return true;
}

function historyLabel(h) {
  if (h.mode === 'verse') return `📖 ${h.reference || 'Verset'} · ${(h.text || '').slice(0, 50)}${(h.text || '').length > 50 ? '…' : ''}`;
  if (h.mode === 'title') return `📢 ${h.title}${h.subtitle ? ' — ' + h.subtitle : ''}`;
  if (h.mode === 'keypoint') return `💡 ${(h.text || '').slice(0, 60)}${(h.text || '').length > 60 ? '…' : ''}`;
  return '?';
}

function renderTextStudioHistory() {
  const wrap = $('textStudioHistory');
  if (!wrap) return;
  if (!textStudioHistory.length) { wrap.innerHTML = ''; return; }
  const itemStyle = 'display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 8px; background:#1a1a1a; border:1px solid #333; border-radius:4px; font-size:11px; margin-bottom:3px; cursor:pointer; line-height:1.3;';
  wrap.innerHTML = `
    <div style="font-size:11px; color:#888; margin:6px 0 4px;">Récents (clic pour rediffuser) :</div>
    ${textStudioHistory.slice(0, 8).map((h, i) => `
      <div class="studio-text-history-item" data-i="${i}" style="${itemStyle}">
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(historyLabel(h))}</span>
        <button class="studio-text-history-save" data-i="${i}" title="Enregistrer comme carte" style="background:none; border:none; color:#888; cursor:pointer; padding:0 4px;">★</button>
        <button class="studio-text-history-del" data-i="${i}" title="Supprimer" style="background:none; border:none; color:#888; cursor:pointer; padding:0 4px;">×</button>
      </div>
    `).join('')}
  `;
  wrap.querySelectorAll('.studio-text-history-item').forEach(el => {
    el.addEventListener('click', (e) => {
      const tgt = e.target;
      const i = parseInt(el.dataset.i, 10);
      if (tgt.classList.contains('studio-text-history-del')) {
        textStudioHistory.splice(i, 1);
        saveTextStudioHistory();
        renderTextStudioHistory();
        return;
      }
      if (tgt.classList.contains('studio-text-history-save')) {
        saveHistoryItemAsTemplate(i);
        return;
      }
      replayHistory(i);
    });
  });
}

function replayHistory(i) {
  const h = textStudioHistory[i];
  if (!h) return;
  diffuseTextStudioState(modeToPayload(h));
  // Remonte l'item en tête (preuve d'usage récent).
  textStudioHistory.splice(i, 1);
  textStudioHistory.unshift({ ...h, ts: Date.now() });
  saveTextStudioHistory();
  renderTextStudioHistory();
  toast('Rediffusé');
}

function modeToPayload(h) {
  if (h.mode === 'verse') return {
    kind: 'verse',
    state: { reference: h.reference || 'Verset', text: h.text || '', translation: 'Manuel', style: verseState?.style || {}, ts: Date.now() }
  };
  if (h.mode === 'title') return {
    kind: 'title',
    state: { title: h.title || '', subtitle: h.subtitle || '', kind: 'title', style: verseState?.style || {} }
  };
  return {
    kind: 'title',
    state: { title: h.text || '', subtitle: '', kind: 'title', style: verseState?.style || {} }
  };
}

// ============ Cartes pré-faites (templates) ============
function saveHistoryItemAsTemplate(i) {
  const h = textStudioHistory[i];
  if (!h) return;
  const name = prompt('Nom de la carte :', historyLabel(h).replace(/^[📖📢💡]\s*/, '').slice(0, 40));
  if (!name) return;
  textStudioTemplates.unshift({ id: 't' + Date.now(), name, ...h });
  saveTextStudioTemplates();
  renderTextStudioTemplates();
  toast('Carte enregistrée');
}

function renderTextStudioTemplates() {
  const wrap = $('textStudioTemplates');
  if (!wrap) return;
  if (!textStudioTemplates.length) {
    wrap.innerHTML = `<div style="font-size:11px; color:#666; margin-top:6px;">Aucune carte enregistrée. ★ sur un texte récent pour le sauvegarder.</div>`;
  } else {
    const itemStyle = 'display:flex; align-items:center; justify-content:space-between; gap:6px; padding:6px 8px; background:#222; border:1px solid #3a3a3a; border-radius:4px; font-size:12px; margin-bottom:3px; cursor:pointer;';
    wrap.innerHTML = `
      <div style="font-size:11px; color:#888; margin:6px 0 4px;">Cartes enregistrées :</div>
      ${textStudioTemplates.map((t) => `
        <div class="studio-text-template-item" data-id="${t.id}" style="${itemStyle}" title="${escapeHtml(historyLabel(t))}">
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${t.mode === 'verse' ? '📖' : t.mode === 'title' ? '📢' : '💡'} ${escapeHtml(t.name)}</span>
          <button class="studio-text-template-del" data-id="${t.id}" title="Supprimer la carte" style="background:none; border:none; color:#888; cursor:pointer; padding:0 4px;">×</button>
        </div>
      `).join('')}
    `;
    wrap.querySelectorAll('.studio-text-template-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const id = el.dataset.id;
        const t = textStudioTemplates.find(x => x.id === id);
        if (!t) return;
        if (e.target.classList.contains('studio-text-template-del')) {
          if (confirm(`Supprimer la carte « ${t.name} » ?`)) {
            textStudioTemplates = textStudioTemplates.filter(x => x.id !== id);
            saveTextStudioTemplates();
            renderTextStudioTemplates();
          }
          return;
        }
        diffuseTextStudioState(modeToPayload(t));
        toast(`Carte « ${t.name} » diffusée`);
      });
    });
  }
  // Miroir dans la modale (autre ID).
  const wrapModal = $('textStudioTemplatesModal');
  if (wrapModal) wrapModal.innerHTML = wrap.innerHTML;
}

// ============ Onglets de mode (visuel actif) ============
function setTextStudioMode(scope, mode) {
  if (scope === 'section') {
    textStudioMode = mode;
    document.querySelectorAll('.text-mode-tab').forEach(b =>
      b.classList.toggle('btn-primary', b.dataset.mode === mode)
    );
    renderTextModeContent('textModeContent', 'textStudio', mode, false);
  } else {
    textStudioModalMode = mode;
    document.querySelectorAll('.text-mode-tab-modal').forEach(b =>
      b.classList.toggle('btn-primary', b.dataset.mode === mode)
    );
    renderTextModeContent('textModeContentModal', 'textStudioModal', mode, true);
  }
}

function openTextStudioModal() {
  const modal = $('textStudioModal');
  if (!modal) return;
  modal.classList.add('show');
  setTextStudioMode('modal', textStudioModalMode);
}
function closeTextStudioModal() {
  $('textStudioModal')?.classList.remove('show');
}

function bindTextStudio() {
  loadTextStudioStorage();
  // Mode tabs section rapide
  document.querySelectorAll('.text-mode-tab').forEach(b => {
    b.addEventListener('click', () => setTextStudioMode('section', b.dataset.mode));
  });
  setTextStudioMode('section', 'verse');
  // Bouton diffuser section rapide
  const diffuseBtn = $('diffuseTextStudioBtn');
  if (diffuseBtn) diffuseBtn.addEventListener('click', () => diffuseFromUI('textStudio', textStudioMode));
  // Bouton ouvrir modale (depuis section ou topbar)
  const openFromSection = $('openTextStudioModalBtn');
  const openFromTopbar = $('openTextStudioModalTopbarBtn');
  if (openFromSection) openFromSection.addEventListener('click', openTextStudioModal);
  if (openFromTopbar) openFromTopbar.addEventListener('click', openTextStudioModal);
  // Modale
  document.querySelectorAll('.text-mode-tab-modal').forEach(b => {
    b.addEventListener('click', () => setTextStudioMode('modal', b.dataset.mode));
  });
  const modalDiffuse = $('textStudioModalDiffuseBtn');
  if (modalDiffuse) modalDiffuse.addEventListener('click', () => {
    if (diffuseFromUI('textStudioModal', textStudioModalMode)) closeTextStudioModal();
  });
  $('textStudioModalClose')?.addEventListener('click', closeTextStudioModal);
  $('textStudioModalCancelBtn')?.addEventListener('click', closeTextStudioModal);
  $('textStudioModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'textStudioModal') closeTextStudioModal();
  });
  // Render historique + templates
  renderTextStudioHistory();
  renderTextStudioTemplates();
}

// Storage fallback (autre onglet)
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  try {
    const state = JSON.parse(e.newValue);
    applyVerseState(state);
    // Forward to TV
    if (state.kind === 'title' && state.title) sendToTv({ type: 'showTitle', payload: state });
    else if (state.text) sendToTv({ type: 'show', payload: state });
    else sendToTv({ type: 'clear' });
    if (state.style) sendToTv({ type: 'style', payload: state.style });
  } catch (err) {}
});

// ============ Utilitaires ============
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hexWithAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ============ Bind UI ============
function bindUi() {
  $('addCameraBtn').addEventListener('click', async () => {
    $('addCameraRow').hidden = false;
    await refreshDeviceList();
  });
  $('cameraAddCancel').addEventListener('click', () => {
    $('addCameraRow').hidden = true;
  });
  $('cameraAddConfirm').addEventListener('click', () => {
    const sel = $('cameraSelect');
    const id = sel.value;
    if (!id) return;
    const label = sel.options[sel.selectedIndex].textContent;
    $('addCameraRow').hidden = true;
    addCamera(id, label);
  });

  $('micSelect').addEventListener('change', (e) => setMicrophone(e.target.value));
  $('micGain').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('micGainVal').textContent = v + ' %';
    if (micGainNode) micGainNode.gain.value = v / 100;
  });

  $('openProjectorBtn').addEventListener('click', openProjector);
  $('recordBtn').addEventListener('click', toggleRecord);

  // Replug device changes
  navigator.mediaDevices.addEventListener('devicechange', refreshDeviceList);

  // Avertir si on quitte pendant un enregistrement
  window.addEventListener('beforeunload', (e) => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      e.preventDefault();
      e.returnValue = 'Un enregistrement est en cours. Quitter va l\'arrêter.';
    }
  });
}

// ============ Caméras à distance (PeerJS) ============
const ROOM_STORAGE_KEY = 'versetlive:studio-room';
const PEER_PREFIX = 'versetlive-studio-';
let signalingPeer = null;
let currentRoomCode = '';
const remoteCalls = new Map(); // deviceKey → { call, sourceId }

function generateRoomCode() {
  // 5 caractères lisibles (sans 0/O/1/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return 'VL-' + code;
}

function getOrCreateRoomCode() {
  let code = localStorage.getItem(ROOM_STORAGE_KEY);
  if (!code) {
    code = generateRoomCode();
    localStorage.setItem(ROOM_STORAGE_KEY, code);
  }
  return code;
}

function getCameraUrl(roomCode) {
  const base = `${location.protocol}//${location.host}`;
  return `${base}/studio-camera.html?room=${encodeURIComponent(roomCode)}`;
}

function renderRoomUi() {
  $('roomCode').textContent = currentRoomCode;
  const url = getCameraUrl(currentRoomCode);
  const urlEl = $('roomUrl');
  urlEl.innerHTML = `<a href="${url}" target="_blank">${url.replace(/^https?:\/\//, '')}</a>`;

  // QR code
  const qrEl = $('roomQr');
  qrEl.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1 });
  } catch (e) {
    qrEl.innerHTML = '<div class="studio-empty">QR indisponible</div>';
  }
}

function setRemoteStatus(text, kind) {
  const el = $('remoteStatus');
  el.textContent = text;
  el.className = 'studio-remote-status' + (kind ? ' ' + kind : '');
}

function initSignaling() {
  if (signalingPeer) { try { signalingPeer.destroy(); } catch (e) {} }
  currentRoomCode = getOrCreateRoomCode();
  renderRoomUi();
  setRemoteStatus('Connexion au signaling…');

  const peerId = PEER_PREFIX + currentRoomCode;
  signalingPeer = new Peer(peerId, { debug: 1 });

  signalingPeer.on('open', (id) => {
    setRemoteStatus(`Prêt — salle ${currentRoomCode}`, 'ok');
  });

  signalingPeer.on('call', (call) => {
    // Auto-accepter, on n'envoie rien en retour (réception seule)
    call.answer();
    call.on('stream', (remoteStream) => {
      addRemoteSource(remoteStream, call);
    });
    call.on('close', () => removeRemoteCall(call));
    call.on('error', (err) => {
      console.warn('call error', err);
      removeRemoteCall(call);
    });
  });

  signalingPeer.on('error', (err) => {
    console.warn('PeerJS error', err.type, err);
    if (err.type === 'unavailable-id') {
      // ID déjà pris : régénérer un code
      regenerateRoom();
    } else if (err.type === 'network' || err.type === 'disconnected') {
      setRemoteStatus('Hors-ligne — reconnexion…', 'err');
      setTimeout(() => signalingPeer && !signalingPeer.destroyed && signalingPeer.reconnect(), 2000);
    } else {
      setRemoteStatus('Erreur : ' + err.type, 'err');
    }
  });

  signalingPeer.on('disconnected', () => {
    setRemoteStatus('Déconnecté — reconnexion…', 'err');
    setTimeout(() => signalingPeer && !signalingPeer.destroyed && signalingPeer.reconnect(), 2000);
  });
}

function regenerateRoom() {
  localStorage.removeItem(ROOM_STORAGE_KEY);
  // Déconnecter les téléphones actuels (ils devront re-flasher le nouveau QR)
  remoteCalls.forEach(({ call }) => { try { call.close(); } catch (e) {} });
  remoteCalls.clear();
  // Retirer les sources distantes
  sources.slice().forEach(s => { if (s.kind === 'remote') removeCamera(s.id); });
  initSignaling();
}

function addRemoteSource(stream, call) {
  // Clé STABLE de l'appareil : le téléphone envoie un deviceId persistant dans
  // call.metadata. Repli sur call.peer pour les anciens téléphones (leur ID
  // PeerJS change à chaque actualisation → pas de dédoublonnage possible).
  const deviceKey = (call.metadata && call.metadata.deviceId) || call.peer;

  // Même appareil déjà présent (reconnexion / actualisation du téléphone) :
  // on réutilise la MÊME caméra (même emplacement, même scène, mêmes filtres)
  // en remplaçant simplement le flux. Évite le doublon + l'ancienne figée.
  const existing = sources.find(s => s.kind === 'remote' && s.deviceKey === deviceKey);
  if (existing) {
    const wasAudioRouted = existing.audioRouted;
    if (wasAudioRouted) disconnectSourceAudio(existing); // détache l'ancien stream
    try { existing.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    existing.stream = stream;
    existing.videoEl.srcObject = stream;
    existing.videoEl.play().catch(() => {});
    existing.peer = call.peer;
    if (wasAudioRouted) connectSourceAudio(existing); // ré-attache le nouveau stream
    // Pointer la clé vers le NOUVEL appel AVANT de fermer l'ancien : la fermeture
    // de l'ancien appel (parfois synchrone) déclenche removeRemoteCall, qui ne
    // doit pas retirer la source qu'on vient de réutiliser.
    const prev = remoteCalls.get(deviceKey);
    remoteCalls.set(deviceKey, { call, sourceId: existing.id });
    if (prev && prev.call && prev.call !== call) { try { prev.call.close(); } catch (e) {} }
    renderSources();
    renderScenes();
    return;
  }

  const remoteCount = sources.filter(s => s.kind === 'remote').length + 1;
  const videoEl = document.createElement('video');
  videoEl.srcObject = stream;
  videoEl.autoplay = true;
  videoEl.muted = true; // on n'utilise pas l'audio distant par défaut (anti-feedback)
  videoEl.playsInline = true;
  videoEl.play().catch(() => {});

  const source = {
    id: 's' + (nextSourceId++),
    kind: 'remote',
    deviceId: 'remote-' + deviceKey, // stable → filtres/PTT persistent après actualisation
    deviceKey,
    label: `📱 Téléphone ${remoteCount}`,
    stream,
    videoEl,
    muted: false,
    peer: call.peer
  };
  sources.push(source);
  remoteCalls.set(deviceKey, { call, sourceId: source.id });

  renderSources();
  renderScenes();
  toast(`Connecté : ${source.label}`);

  // Diagnostic : confirmer qu'une vraie image vidéo arrive (et pas seulement
  // l'audio → tuile noire). On signale la résolution reçue, ou un avertissement
  // si la vidéo reste à 0×0 (piste absente ou « née noire » côté téléphone).
  diagnoseRemoteVideo(videoEl, source.label);
}

function diagnoseRemoteVideo(videoEl, label) {
  const vTracks = videoEl.srcObject ? videoEl.srcObject.getVideoTracks() : [];
  if (!vTracks.length) {
    toast(`⚠️ ${label} : aucune piste vidéo reçue (audio seul)`);
    return;
  }
  let resolved = false;
  const report = () => {
    if (resolved) return;
    if (videoEl.videoWidth && videoEl.videoHeight) {
      resolved = true;
      toast(`📐 ${label} : ${videoEl.videoWidth}×${videoEl.videoHeight}`);
    }
  };
  videoEl.addEventListener('loadedmetadata', report);
  videoEl.addEventListener('resize', report);
  report();
  setTimeout(() => {
    if (!resolved) toast(`⚠️ ${label} : vidéo reçue mais image noire (0×0)`);
  }, 4000);
}

function removeRemoteCall(call) {
  // Retrouver l'entrée correspondant précisément à CET appel. Si l'appel a déjà
  // été remplacé (téléphone actualisé → nouvel appel sous la même clé), il n'est
  // plus référencé : on ignore, pour ne pas retirer la caméra réutilisée.
  let key = null, entry = null;
  for (const [k, e] of remoteCalls) { if (e.call === call) { key = k; entry = e; break; } }
  if (!entry) return;
  const src = sources.find(s => s.id === entry.sourceId);
  if (src) {
    // L'audio routé via Web Audio sera nettoyé par disconnectSourceAudio()
    disconnectSourceAudio(src);
    src.stream.getTracks().forEach(t => t.stop());
    const idx = sources.indexOf(src);
    sources.splice(idx, 1);
  }
  remoteCalls.delete(key);
  renderSources();
  renderScenes();
  if (src && (programScene.primaryId === src.id || programScene.secondaryId === src.id)) {
    setScene(sources.length ? { kind: 'camera', primaryId: sources[0].id } : { kind: 'black' });
  }
  toast(`${src ? src.label : 'Téléphone'} déconnecté`);
}

// Aide
function bindRemoteHelp() {
  const open = () => $('remoteHelpModal').classList.add('show');
  const close = () => $('remoteHelpModal').classList.remove('show');
  $('remoteHelpBtn').addEventListener('click', open);
  $('remoteHelpClose').addEventListener('click', close);
  $('remoteHelpOk').addEventListener('click', close);
  $('regenRoomBtn').addEventListener('click', () => {
    if (confirm('Générer un nouveau code de salle ? Les téléphones actuellement connectés seront déconnectés.')) {
      regenerateRoom();
    }
  });
}

// ============ Connexion TV (PeerJS) ============
const TV_PEER_PREFIX = 'versetlive-tv-';
let tvDataConn = null;
let tvMediaCall = null;
let tvPeerId = null;

function setTvConnected(connected) {
  $('tvDot').classList.toggle('connected', connected);
  $('tvPairRow').hidden = connected;
  $('tvStatusRow').hidden = !connected;
  // (toggle supprimé — mode géré via radio buttons)
  // Mise à jour du panneau Sorties unifié
  const card = $('outputTvCard');
  if (card) card.classList.toggle('connected', connected);
  const statusEl = $('outputTvStatus');
  if (statusEl) {
    statusEl.textContent = connected
      ? (tvPeerId ? `✓ Connecté (${tvPeerId.replace('versetlive-tv-', '')})` : '✓ Connecté')
      : 'Aucun écran connecté';
  }
  const connectBtn = $('outputTvConnect');
  const disconnectBtn = $('outputTvDisconnect');
  if (connectBtn) connectBtn.hidden = connected;
  if (disconnectBtn) disconnectBtn.hidden = !connected;
}

function setTvStatusText(text) {
  $('tvStatusText').textContent = text;
}

function sendToTv(msg) {
  if (!tvDataConn || !tvDataConn.open) return;
  try { tvDataConn.send(msg); } catch (e) {}
}

// ============ Snapshots canvas → TV (5 fps) ============
// Approche alternative au WebRTC vidéo : envoie des JPEG via le data channel.
// Compatible avec tout navigateur (juste <img src>), pas de blocage autoplay,
// pas de souci de codec WebRTC. ~5 fps suffit pour de la projection en salle.
let tvSnapshotTimer = null;
let tvSnapshotCanvas = null;
let tvSnapshotCtx = null;

// Réglages qualité MAX réseau local : Full HD 1920x1080, JPEG 92%, ~25 fps
// Transport binaire pur (Blob) pour éviter l'overhead base64.
// Encodage async (toBlob) → l'UI ne bloque plus, on peut tenir une cadence haute.
// Bande passante estimée ~60-100 Mbps. Backpressure à 4 MB.
const TV_SNAPSHOT_W = 1920;
const TV_SNAPSHOT_H = 1080;
const TV_SNAPSHOT_QUALITY = 0.92;
const TV_SNAPSHOT_INTERVAL_MS = 33; // ≈ 30 fps (max raisonnable, limite œil/canvas)

function ensureTvSnapshotCanvas() {
  if (!tvSnapshotCanvas) {
    tvSnapshotCanvas = document.createElement('canvas');
    tvSnapshotCanvas.width = TV_SNAPSHOT_W;
    tvSnapshotCanvas.height = TV_SNAPSHOT_H;
    tvSnapshotCtx = tvSnapshotCanvas.getContext('2d', { alpha: false });
  }
}

let snapshotSeq = 0;
let skippedFrames = 0;
let snapshotInflight = 0;
function captureAndSendSnapshot() {
  if (!tvDataConn || !tvDataConn.open) return;
  if (!programCanvas) return;
  // Backpressure : si le buffer du data channel est trop rempli, on saute cette frame
  try {
    const dc = tvDataConn._dc || tvDataConn.dataChannel;
    if (dc && dc.bufferedAmount > 4_000_000) {
      skippedFrames++;
      return;
    }
  } catch (e) {}
  // Empêche plus de 3 captures en vol simultanées (pipeline async)
  if (snapshotInflight > 3) {
    skippedFrames++;
    return;
  }

  let sourceCanvas = programCanvas;
  if (programCanvas.width !== TV_SNAPSHOT_W || programCanvas.height !== TV_SNAPSHOT_H) {
    ensureTvSnapshotCanvas();
    tvSnapshotCtx.drawImage(programCanvas, 0, 0, tvSnapshotCanvas.width, tvSnapshotCanvas.height);
    sourceCanvas = tvSnapshotCanvas;
  }

  snapshotInflight++;
  // toBlob ASYNC → l'encodage JPEG ne bloque plus le main thread (peut tenir 25-30 fps)
  sourceCanvas.toBlob((blob) => {
    snapshotInflight--;
    if (!blob || !tvDataConn || !tvDataConn.open) return;
    try {
      // Envoie le Blob brut : PeerJS le sérialise nativement en binaire (pas de base64)
      tvDataConn.send(blob);
      snapshotSeq++;
      const el = $('tvStatusText');
      if (el) {
        const kb = Math.round(blob.size / 1024);
        el.textContent = `Connecté (Full HD ${snapshotSeq}f · ${kb} Ko${skippedFrames ? ` · ${skippedFrames}↓` : ''})`;
      }
      const statusEl = $('outputTvStatus');
      if (statusEl) statusEl.textContent = `✓ Full HD 1920×1080 · ${snapshotSeq} frames`;
    } catch (e) {
      console.warn('snapshot send failed', e);
    }
  }, 'image/jpeg', TV_SNAPSHOT_QUALITY);
}

function startTvSnapshots() {
  if (tvSnapshotTimer) return;
  startKeepAlive(); // garde le canvas vivant en arrière-plan (sinon la TV gèle)
  sendToTv({ type: 'tv-mode', mode: 'snapshot' });
  tvSnapshotTimer = setInterval(captureAndSendSnapshot, TV_SNAPSHOT_INTERVAL_MS);
}

function stopTvSnapshots() {
  if (tvSnapshotTimer) {
    clearInterval(tvSnapshotTimer);
    tvSnapshotTimer = null;
    sendToTv({ type: 'tv-mode', mode: 'text' });
  }
}

// ============ Mode de transmission vidéo TV ============
const TV_VIDEO_MODE_KEY = 'versetlive:tv-video-mode';
let tvVideoMode = localStorage.getItem(TV_VIDEO_MODE_KEY) || 'snapshot'; // 'snapshot' | 'webrtc'

function setTvVideoMode(mode) {
  if (mode !== 'snapshot' && mode !== 'webrtc') return;
  if (tvVideoMode === mode) return;
  tvVideoMode = mode;
  try { localStorage.setItem(TV_VIDEO_MODE_KEY, mode); } catch (e) {}
  // Coupe l'ancien mode et applique le nouveau pour la scène en cours
  stopTvSnapshots();
  stopTvVideo(true);
  autoSwitchTvForScene(programScene);
}

// Auto-switch : appelé depuis setProgramScene
function autoSwitchTvForScene(scene) {
  if (!tvDataConn || !tvDataConn.open) return;
  // En mode texte pur (verset plein écran ou noir), on coupe tout transport vidéo
  // et la TV retombe sur l'affichage texte via obs.js
  if (!scene || scene.kind === 'verse' || scene.kind === 'black') {
    stopTvSnapshots();
    stopTvVideo(true);
    return;
  }
  // Sinon, démarre selon le mode choisi
  if (tvVideoMode === 'webrtc') {
    stopTvSnapshots();
    startTvVideo();
  } else {
    stopTvVideo(true);
    startTvSnapshots();
  }
}

function sendCurrentVerseToTv() {
  if (!verseState) {
    sendToTv({ type: 'clear' });
    return;
  }
  if (verseState.style) sendToTv({ type: 'style', payload: verseState.style });
  if (verseState.kind === 'title' && verseState.title) {
    sendToTv({ type: 'showTitle', payload: verseState });
  } else if (verseState.text) {
    sendToTv({ type: 'show', payload: verseState });
  } else {
    sendToTv({ type: 'clear' });
  }
}

function connectToTv(code) {
  const c = code.trim().toUpperCase();
  if (c.length !== 4) {
    toast('Le code TV doit faire 4 caractères', true);
    return;
  }
  if (!signalingPeer || signalingPeer.disconnected || signalingPeer.destroyed) {
    toast('Signaling pas prêt, réessaie dans quelques secondes', true);
    return;
  }

  // Fermer une éventuelle connexion existante
  disconnectFromTv(/* silent */ true);

  tvPeerId = TV_PEER_PREFIX + c;
  const conn = signalingPeer.connect(tvPeerId, { reliable: true });

  let openTimer = setTimeout(() => {
    if (conn && !conn.open) {
      toast(`Aucune TV ne répond avec le code ${c}. Vérifie que la TV est bien sur la page /tv.`, true);
      try { conn.close(); } catch (e) {}
    }
  }, 8000);

  conn.on('open', () => {
    clearTimeout(openTimer);
    tvDataConn = conn;
    setTvConnected(true);
    setTvStatusText(`Connecté à la TV ${c}`);
    toast(`TV ${c} connectée`);
    // Pousser l'état actuel
    sendCurrentVerseToTv();
    // Démarrer le mode auto (snapshots si scène ≠ verset/noir)
    autoSwitchTvForScene(programScene);
  });

  conn.on('data', (msg) => {
    // Pas grand chose à recevoir pour l'instant (hello)
    if (msg && msg.type === 'hello') {
      console.log('TV says hello');
    }
  });

  conn.on('close', () => {
    clearTimeout(openTimer);
    if (tvDataConn === conn) {
      tvDataConn = null;
      tvPeerId = null;
      setTvConnected(false);
      setTvStatusText('Déconnecté');
      stopTvVideo(/* silent */ true);
      if (tvSnapshotTimer) { clearInterval(tvSnapshotTimer); tvSnapshotTimer = null; }
      toast('TV déconnectée');
    }
  });

  conn.on('error', (err) => {
    clearTimeout(openTimer);
    console.warn('TV conn error', err);
    toast('Erreur de connexion TV : ' + (err.type || err.message || 'inconnue'), true);
  });
}

function disconnectFromTv(silent) {
  stopTvVideo(true);
  if (tvSnapshotTimer) { clearInterval(tvSnapshotTimer); tvSnapshotTimer = null; }
  if (tvDataConn) {
    try { tvDataConn.send({ type: 'tv-disconnect' }); } catch (e) {}
    try { tvDataConn.close(); } catch (e) {}
    tvDataConn = null;
  }
  tvPeerId = null;
  setTvConnected(false);
  setTvStatusText('Déconnecté');
  if (!silent) toast('TV déconnectée');
}

function startTvVideo() {
  if (!tvPeerId || !signalingPeer || signalingPeer.disconnected) {
    toast('TV pas connectée', true);
    /* toggle supprimé — mode sélectionné via radio buttons */
    return;
  }
  if (!programStream) rebuildProgramStream();
  startKeepAlive(); // garde le canvas vivant en arrière-plan (sinon la TV gèle)
  if (!programStream || !programStream.getVideoTracks().length) {
    toast('Aucune source vidéo dans le programme. Ajoute une caméra d\'abord.', true);
    /* toggle supprimé — mode sélectionné via radio buttons */
    return;
  }
  if (tvMediaCall) {
    try { tvMediaCall.close(); } catch (e) {}
    tvMediaCall = null;
  }
  // Stream vidéo-seul pour la TV (pas d'audio = pas de blocage autoplay sur les Smart TV)
  // L'audio passe de toute façon par la sono de la salle, pas la TV.
  const videoOnly = new MediaStream(programStream.getVideoTracks());
  tvMediaCall = signalingPeer.call(tvPeerId, videoOnly);
  if (!tvMediaCall) {
    toast('Impossible de démarrer la vidéo vers la TV', true);
    /* toggle supprimé — mode sélectionné via radio buttons */
    return;
  }
  tvMediaCall.on('close', () => {
    if (tvMediaCall) {
      tvMediaCall = null;
      /* toggle supprimé — mode sélectionné via radio buttons */
    }
  });
  tvMediaCall.on('error', (err) => {
    console.warn('TV call error', err);
    toast('Erreur vidéo TV : ' + (err.type || err.message || 'inconnue'), true);
    tvMediaCall = null;
    /* toggle supprimé — mode sélectionné via radio buttons */
  });
  toast('Mix vidéo envoyé à la TV');
}

function stopTvVideo(silent) {
  if (tvMediaCall) {
    try { tvMediaCall.close(); } catch (e) {}
    tvMediaCall = null;
  }
  sendToTv({ type: 'video-stop' });
  if (!silent) toast('Mix vidéo arrêté');
}

function bindTvUi() {
  const open = () => $('tvModal').classList.add('show');
  const close = () => $('tvModal').classList.remove('show');
  $('openTvBtn').addEventListener('click', open);
  $('tvModalClose').addEventListener('click', close);
  $('tvModalOk').addEventListener('click', close);

  const input = $('tvCodeInput');
  input.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      connectToTv(input.value);
    }
  });
  $('tvConnectBtn').addEventListener('click', () => connectToTv(input.value));
  $('tvDisconnectBtn').addEventListener('click', () => disconnectFromTv(false));

  // Mode de transmission vidéo (snapshot vs webrtc) — radio
  const modeSnapshot = $('tvModeSnapshot');
  const modeWebrtc = $('tvModeWebrtc');
  if (modeSnapshot && modeWebrtc) {
    if (tvVideoMode === 'webrtc') modeWebrtc.checked = true;
    else modeSnapshot.checked = true;
    modeSnapshot.addEventListener('change', () => modeSnapshot.checked && setTvVideoMode('snapshot'));
    modeWebrtc.addEventListener('change', () => modeWebrtc.checked && setTvVideoMode('webrtc'));
  }
}

// ============ Diffusion multi-plateformes (RELAIS LOCAL) ============
const RELAY_URL = 'wss://localhost:8766';
const RELAY_HEALTH_URL = 'https://localhost:8766/health';
const DEST_STORAGE_KEY = 'versetlive:destinations';

const DEST_PRESETS = [
  { name: 'YouTube',  url: 'rtmp://a.rtmp.youtube.com/live2',          key: '', placeholderKey: 'xxxx-xxxx-xxxx-xxxx-xxxx' },
  { name: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp', key: '', placeholderKey: 'FB-XXXXXXXXX-X' },
  { name: 'Twitch',   url: 'rtmp://live.twitch.tv/app',                key: '', placeholderKey: 'live_XXXXXXXXX_XXXXXXX' }
];

let relayWs = null;
let relayStreaming = false;
let streamRecorder = null;
let streamStartedAt = 0;
let streamStatsTimer = null;
let destinations = loadDestinations();

function loadDestinations() {
  try {
    const raw = localStorage.getItem(DEST_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return DEST_PRESETS.map(p => ({ ...p, enabled: false }));
}

function saveDestinations() {
  // Ne pas sauvegarder les clés sensibles si l'utilisateur préfère
  localStorage.setItem(DEST_STORAGE_KEY, JSON.stringify(destinations));
}

function renderDestinations() {
  if (typeof coopBroadcast === 'function') coopBroadcast();
  const list = $('destinationsList');
  list.innerHTML = '';
  destinations.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'studio-destination';
    row.innerHTML = `
      <div class="studio-destination-head">
        <label class="studio-destination-toggle">
          <input type="checkbox" data-i="${i}" data-field="enabled" ${d.enabled ? 'checked' : ''}>
          <span class="studio-destination-name">${escapeHtml(d.name)}</span>
        </label>
        <button class="btn btn-sm studio-destination-remove" data-i="${i}" title="Supprimer">×</button>
      </div>
      <div class="studio-destination-fields">
        <input type="text" placeholder="rtmp://…" value="${escapeHtml(d.url)}" data-i="${i}" data-field="url">
        <input type="password" placeholder="${escapeHtml(d.placeholderKey || 'Clé de stream')}" value="${escapeHtml(d.key)}" data-i="${i}" data-field="key">
      </div>
    `;
    list.appendChild(row);
  });

  // Bind inputs
  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const i = parseInt(e.target.dataset.i, 10);
      const f = e.target.dataset.field;
      destinations[i][f] = (f === 'enabled') ? e.target.checked : e.target.value;
      saveDestinations();
      updateStreamBtnState();
    });
    inp.addEventListener('input', (e) => {
      if (e.target.dataset.field !== 'enabled') {
        const i = parseInt(e.target.dataset.i, 10);
        destinations[i][e.target.dataset.field] = e.target.value;
        saveDestinations();
        updateStreamBtnState();
      }
    });
  });
  list.querySelectorAll('.studio-destination-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.target.dataset.i, 10);
      if (confirm(`Supprimer la destination « ${destinations[i].name} » ?`)) {
        destinations.splice(i, 1);
        saveDestinations();
        renderDestinations();
        updateStreamBtnState();
      }
    });
  });
}

function addDestination() {
  // Propose un preset non encore présent, sinon vide
  const usedNames = new Set(destinations.map(d => d.name));
  const preset = DEST_PRESETS.find(p => !usedNames.has(p.name));
  destinations.push(preset ? { ...preset, enabled: false } : { name: 'Personnalisé', url: '', key: '', enabled: false });
  saveDestinations();
  renderDestinations();
  updateStreamBtnState();
}

function activeDestinations() {
  return destinations.filter(d => d.enabled && d.url && d.key);
}

function updateStreamBtnState() {
  const btn = $('streamBtn');
  if (relayStreaming) {
    btn.disabled = false;
    btn.textContent = '⏹ Arrêter le stream';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
    return;
  }
  const relayOk = relayWs && relayWs.readyState === WebSocket.OPEN;
  const dests = activeDestinations();
  if (!relayOk) {
    btn.disabled = true;
    btn.textContent = '▶ Démarrer le stream (relais hors-ligne)';
  } else if (!dests.length) {
    btn.disabled = true;
    btn.textContent = '▶ Démarrer le stream (aucune destination active)';
  } else {
    btn.disabled = false;
    btn.textContent = `▶ Démarrer le stream (${dests.length} destination${dests.length > 1 ? 's' : ''})`;
  }
  btn.classList.add('btn-primary');
  btn.classList.remove('btn-danger');
}

function setRelayStatus(state, label) {
  const pill = $('relayPill');
  const dot = $('relayDot');
  const lbl = $('relayLabel');
  pill.classList.remove('ok', 'err', 'warn');
  dot.classList.remove('ok', 'err', 'warn');
  if (state === 'ok') { pill.classList.add('ok'); dot.classList.add('ok'); }
  else if (state === 'warn') { pill.classList.add('warn'); dot.classList.add('warn'); }
  else if (state === 'err') { pill.classList.add('err'); dot.classList.add('err'); }
  lbl.textContent = label;
  $('relayHelp').style.display = (state === 'ok') ? 'none' : '';
}

function connectRelay() {
  setRelayStatus('warn', 'Connexion au relais…');
  try {
    relayWs = new WebSocket(RELAY_URL);
  } catch (e) {
    setRelayStatus('err', 'Relais hors-ligne');
    updateStreamBtnState();
    return;
  }

  relayWs.binaryType = 'arraybuffer';

  relayWs.onopen = () => {
    setRelayStatus('ok', 'Relais en ligne');
    updateStreamBtnState();
  };
  relayWs.onclose = () => {
    setRelayStatus('err', 'Relais déconnecté');
    if (relayStreaming) stopStreaming('relay-disconnect');
    updateStreamBtnState();
    // Retry doux après 5s
    setTimeout(connectRelay, 5000);
  };
  relayWs.onerror = () => {
    setRelayStatus('err', 'Relais hors-ligne');
    updateStreamBtnState();
  };
  relayWs.onmessage = (evt) => {
    if (typeof evt.data !== 'string') return;
    try { handleRelayMessage(JSON.parse(evt.data)); } catch (e) {}
  };
}

function handleRelayMessage(msg) {
  if (msg.type === 'hello') {
    console.log('Relay hello', msg);
  } else if (msg.type === 'started') {
    toast(`Stream démarré (${msg.destinations.length} destination(s))`);
  } else if (msg.type === 'stopped') {
    if (relayStreaming) finalizeStop();
  } else if (msg.type === 'error') {
    toast('Relais: ' + msg.message, true);
  } else if (msg.type === 'ffmpeg-log' && msg.level === 'error') {
    toast('ffmpeg: ' + msg.line, true);
  } else if (msg.type === 'stats') {
    if (msg.fps) $('streamFps').textContent = `${msg.fps.toFixed(0)} fps`;
    if (msg.bitrate) $('streamBitrate').textContent = msg.bitrate;
  }
}

function startStreaming() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    toast('Relais hors-ligne', true);
    return;
  }
  const dests = activeDestinations();
  if (!dests.length) {
    toast('Aucune destination active', true);
    return;
  }
  if (!programStream) rebuildProgramStream();
  startKeepAlive();

  // Préparer MediaRecorder sur le stream du programme
  const mime = pickStreamMime();
  if (!mime) {
    toast('Aucun codec compatible', true);
    return;
  }

  try {
    streamRecorder = new MediaRecorder(programStream, {
      mimeType: mime,
      videoBitsPerSecond: streamBitrate(),
      audioBitsPerSecond: audioBitrate(),
    });
  } catch (e) {
    toast('MediaRecorder: ' + e.message, true);
    return;
  }

  streamRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0 && relayWs?.readyState === WebSocket.OPEN) {
      const buf = await e.data.arrayBuffer();
      relayWs.send(buf);
    }
  };
  streamRecorder.onerror = (e) => {
    toast('Enregistrement: ' + (e.error?.message || 'erreur'), true);
    stopStreaming('recorder-error');
  };

  // Envoyer la commande start au relais
  relayWs.send(JSON.stringify({
    type: 'start',
    destinations: dests.map(d => ({ name: d.name, url: d.url, key: d.key }))
  }));

  // Démarrer le recorder avec timeslice de 250ms (faible latence)
  streamRecorder.start(250);
  relayStreaming = true;
  streamStartedAt = Date.now();
  $('streamStats').hidden = false;
  startStreamElapsedTimer();
  updateStreamBtnState();
  setStatus('● Diffusion en direct');
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

function stopStreaming(reason = 'user') {
  if (!relayStreaming) return;
  try { if (streamRecorder?.state !== 'inactive') streamRecorder.stop(); } catch (e) {}
  if (relayWs?.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify({ type: 'stop' }));
  }
  finalizeStop();
}

function finalizeStop() {
  relayStreaming = false;
  streamRecorder = null;
  if (streamStatsTimer) { clearInterval(streamStatsTimer); streamStatsTimer = null; }
  $('streamStats').hidden = true;
  $('streamFps').textContent = '— fps';
  $('streamBitrate').textContent = '— kbps';
  updateStreamBtnState();
  setStatus('Prêt');
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

function startStreamElapsedTimer() {
  if (streamStatsTimer) clearInterval(streamStatsTimer);
  streamStatsTimer = setInterval(() => {
    const s = Math.floor((Date.now() - streamStartedAt) / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    $('streamElapsed').textContent = `${h}:${m}:${sec}`;
  }, 1000);
}

function pickStreamMime() {
  const candidates = [
    'video/webm;codecs=vp8,opus',  // VP8 plus rapide à décoder côté ffmpeg
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function bindStreaming() {
  $('addDestBtn').addEventListener('click', addDestination);
  $('streamBtn').addEventListener('click', () => {
    if (relayStreaming) {
      if (confirm('Arrêter la diffusion en direct ?')) stopStreaming('user');
    } else {
      startStreaming();
    }
  });
}

// ============ Raccourcis clavier ============
function isTypingField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingField()) return;
    // Aucune modale ouverte (cf. .show class)
    if (document.querySelector('.modal-backdrop.show')) return;

    const key = e.key;

    // 1-9 : sélectionner la N-ième scène
    if (/^[1-9]$/.test(key)) {
      const idx = parseInt(key, 10) - 1;
      const scenes = buildSceneList();
      if (scenes[idx]) {
        e.preventDefault();
        setScene(scenes[idx].scene);
      }
      return;
    }

    // 0 : noir
    if (key === '0') {
      e.preventDefault();
      setScene({ kind: 'black' });
      return;
    }

    // Espace : démarrer/arrêter le stream
    if (key === ' ') {
      e.preventDefault();
      $('streamBtn').click();
      return;
    }

    // R : démarrer/arrêter l'enregistrement
    if (key === 'r' || key === 'R') {
      e.preventDefault();
      toggleRecord();
      return;
    }

    // V : scène verset plein écran
    if (key === 'v' || key === 'V') {
      e.preventDefault();
      setScene({ kind: 'verse' });
      return;
    }

    // Entrée : Take (envoyer preview → program) — seulement en mode Preview/Program
    if (key === 'Enter' && studioMode) {
      e.preventDefault();
      takeProgram();
      return;
    }
  });
}

// ============ Push-to-talk / Push-to-mute par source audio ============
// Bindings stockés par deviceId (ou source.id en fallback). Mode 'off' = pas
// de raccourci, 'ptt' = audio coupé sauf quand la touche est maintenue,
// 'ptm' = audio passé sauf quand la touche est maintenue.
const PTT_BINDINGS_KEY = 'versetlive:ptt-bindings';
function loadPttBindings() {
  try { return JSON.parse(localStorage.getItem(PTT_BINDINGS_KEY) || '{}'); }
  catch (e) { return {}; }
}
let pttBindings = loadPttBindings();
function savePttBindings() { try { localStorage.setItem(PTT_BINDINGS_KEY, JSON.stringify(pttBindings)); } catch (e) {} }
function pttIdFor(source) { return source.deviceId || ('id:' + source.id); }
function getPttBinding(source) {
  const id = pttIdFor(source);
  return pttBindings[id] || { mode: 'off', key: '' };
}
function setPttBinding(source, partial) {
  const id = pttIdFor(source);
  const cur = pttBindings[id] || { mode: 'off', key: '' };
  pttBindings[id] = { ...cur, ...partial };
  if (pttBindings[id].mode === 'off') delete pttBindings[id];
  savePttBindings();
  applyPttGain(source);
}
// Quand une touche est maintenue : recalcule le gain effectif appliqué au GainNode.
function applyPttGain(source) {
  if (!source.audioGain) return;
  const b = getPttBinding(source);
  let g = source.audioGainValue ?? 1.0;
  if (b.mode === 'ptt') g = source.pttActive ? g : 0;
  else if (b.mode === 'ptm') g = source.pttActive ? 0 : g;
  source.audioGain.gain.value = g;
}
const pttKeysDown = new Set();
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  // Ignore si on tape dans un input/textarea/contenteditable ou si modificateur
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = pttNormalizeKey(e.key);
  if (!key) return;
  pttKeysDown.add(key);
  sources.forEach(s => {
    const b = getPttBinding(s);
    if (b.mode !== 'off' && b.key === key) {
      s.pttActive = true;
      applyPttGain(s);
    }
  });
});
window.addEventListener('keyup', (e) => {
  const key = pttNormalizeKey(e.key);
  if (!key) return;
  pttKeysDown.delete(key);
  sources.forEach(s => {
    const b = getPttBinding(s);
    if (b.mode !== 'off' && b.key === key) {
      s.pttActive = false;
      applyPttGain(s);
    }
  });
});
function pttNormalizeKey(k) {
  if (!k) return '';
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toLowerCase();
  return k; // Shift, Control, etc.
}

// Capture la prochaine touche pressée pour binder le raccourci PTT/PTM.
function captureNextKeyFor(source, btn) {
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = 'Appuie sur une touche…';
  btn.classList.add('btn-primary');
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cleanup();
      btn.textContent = original;
      btn.classList.remove('btn-primary');
      return;
    }
    const key = pttNormalizeKey(e.key);
    if (!key) return;
    setPttBinding(source, { key });
    cleanup();
    renderSources();
  };
  function cleanup() { window.removeEventListener('keydown', onKey, true); }
  window.addEventListener('keydown', onKey, true);
}

// ============ Audio des téléphones (routing optionnel) ============
function connectSourceAudio(source) {
  if (!source || source.audioRouted) return;
  if (!source.stream.getAudioTracks().length) return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!audioDest) rebuildAudioGraph();
  try {
    if (source.audioGainValue == null) source.audioGainValue = 1.0;
    if (source.pttActive == null) source.pttActive = false;
    source.audioSrc = audioCtx.createMediaStreamSource(source.stream);
    source.audioGain = audioCtx.createGain();
    source.audioGain.gain.value = source.audioGainValue;
    applyPttGain(source); // si binding PTM, démarre déjà passé ; PTT démarre coupé
    source.audioAnalyser = audioCtx.createAnalyser();
    source.audioAnalyser.fftSize = 256;
    source.audioSrc.connect(source.audioGain);
    source.audioGain.connect(audioDest);
    source.audioGain.connect(source.audioAnalyser);
    source.audioRouted = true;
    rebuildProgramStream();
  } catch (e) {
    console.warn('connectSourceAudio failed', e);
  }
}

function disconnectSourceAudio(source) {
  if (!source || !source.audioRouted) return;
  try { source.audioGain && source.audioGain.disconnect(); } catch (e) {}
  try { source.audioSrc && source.audioSrc.disconnect(); } catch (e) {}
  try { source.audioAnalyser && source.audioAnalyser.disconnect(); } catch (e) {}
  source.audioGain = null;
  source.audioSrc = null;
  source.audioAnalyser = null;
  source.audioRouted = false;
  rebuildProgramStream();
}

function toggleSourceAudio(sourceId) {
  const src = sources.find(s => s.id === sourceId);
  if (!src) return;
  if (src.audioRouted) disconnectSourceAudio(src);
  else connectSourceAudio(src);
  renderSources();
}

// VU mètres par source — boucle unique partagée.
function startSourceVuLoop() {
  const data = new Uint8Array(128);
  function loop() {
    sources.forEach(s => {
      if (!s.audioRouted || !s.audioAnalyser) return;
      const vu = document.getElementById('vu-' + s.id);
      if (!vu) return;
      s.audioAnalyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const pct = Math.min(100, Math.round((avg / 255) * 220));
      const bar = vu.querySelector('.studio-source-vu-bar');
      if (bar) bar.style.width = pct + '%';
      vu.classList.toggle('hot', pct > 85);
    });
    requestAnimationFrame(loop);
  }
  loop();
}

// ============ Images / Logos ============
const IMG_DB = 'versetlive-images';
const IMG_STORE = 'images';
const IMG_INDEX_KEY = 'versetlive:images-index';
const IMG_LOGO_KEY = 'versetlive:logo-overlay';
let imgDbPromise = null;

function openImgDb() {
  if (imgDbPromise) return imgDbPromise;
  imgDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IMG_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMG_STORE)) db.createObjectStore(IMG_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return imgDbPromise;
}
async function imgIdbPut(key, blob) {
  const db = await openImgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function imgIdbGet(key) {
  const db = await openImgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMG_STORE, 'readonly');
    const req = tx.objectStore(IMG_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function imgIdbDel(key) {
  const db = await openImgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function loadImgIndex() {
  try { return JSON.parse(localStorage.getItem(IMG_INDEX_KEY) || '[]'); }
  catch (e) { return []; }
}
function saveImgIndex() {
  const idx = imageSources.map(i => ({
    id: i.id, name: i.name,
    scale: i.scale, offsetX: i.offsetX, offsetY: i.offsetY
  }));
  localStorage.setItem(IMG_INDEX_KEY, JSON.stringify(idx));
}
function loadLogoCfg() {
  try {
    const raw = localStorage.getItem(IMG_LOGO_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      logoOverlayId = c.id || null;
      logoOverlayEnabled = !!c.enabled;
    }
  } catch (e) {}
}
function saveLogoCfg() {
  localStorage.setItem(IMG_LOGO_KEY, JSON.stringify({ id: logoOverlayId, enabled: logoOverlayEnabled }));
}

async function loadStoredImages() {
  const idx = loadImgIndex();
  let maxId = 0;
  for (const meta of idx) {
    try {
      const blob = await imgIdbGet('img-' + meta.id);
      if (!blob) continue;
      const dataUrl = await blobToDataUrl(blob);
      const img = await loadImageElement(dataUrl);
      imageSources.push({
        id: meta.id, name: meta.name, dataUrl, imgEl: img,
        scale: meta.scale, offsetX: meta.offsetX, offsetY: meta.offsetY
      });
      const n = parseInt(meta.id.replace(/^im/, ''), 10);
      if (!isNaN(n) && n > maxId) maxId = n;
    } catch (e) { console.warn('Image load failed', meta, e); }
  }
  nextImageId = maxId + 1;
  loadLogoCfg();
  loadCards();
  renderImages();
  renderLogoOverlayUi();
  renderCards();
  renderScenes();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image decode failed'));
    im.src = src;
  });
}

async function addImageFromFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast('Image trop lourde (>8 Mo). Compresse-la avant.', true);
    return;
  }
  const id = 'im' + (nextImageId++);
  const dataUrl = await blobToDataUrl(file);
  const imgEl = await loadImageElement(dataUrl);
  const name = (file.name || 'Image').replace(/\.[^.]+$/, '').slice(0, 30);
  imageSources.push({ id, name, dataUrl, imgEl });
  try { await imgIdbPut('img-' + id, file); } catch (e) { console.warn('IDB put failed', e); }
  saveImgIndex();
  renderImages();
  renderLogoOverlayUi();
  renderScenes();
  toast(`Image ajoutée : ${name}`);
}

async function removeImage(id) {
  const idx = imageSources.findIndex(i => i.id === id);
  if (idx < 0) return;
  const removed = imageSources[idx];
  imageSources.splice(idx, 1);
  try { await imgIdbDel('img-' + id); } catch (e) {}
  saveImgIndex();
  // Si la scène active utilise cette image → bascule noir
  if (programScene.imageId === id) setProgramScene({ kind: 'black' });
  if (previewScene.imageId === id) setPreviewScene({ kind: 'black' });
  // Si c'était le logo overlay actif → nettoyer
  if (logoOverlayId === id) {
    logoOverlayId = null;
    logoOverlayEnabled = false;
    saveLogoCfg();
  }
  renderImages();
  renderLogoOverlayUi();
  renderScenes();
  toast(`Image retirée : ${removed.name}`);
}

function renderImages() {
  const list = $('imagesList');
  if (!imageSources.length) {
    list.innerHTML = '<div class="studio-empty">Ajoute logo, photos, annonces. Chaque image devient une scène.</div>';
    return;
  }
  list.innerHTML = '';
  imageSources.forEach(img => {
    const card = document.createElement('div');
    card.className = 'studio-image-card';
    card.innerHTML = `
      <div class="studio-image-thumb"><img src="${img.dataUrl}" alt=""></div>
      <div class="studio-image-meta">
        <span class="studio-image-name" title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</span>
        <button class="btn btn-sm studio-image-fit-btn" data-id="${img.id}" title="Taille et position de l'image">⤢</button>
        <button class="btn btn-sm btn-danger studio-image-remove" data-id="${img.id}" title="Retirer">×</button>
      </div>
      <div class="studio-video-fit" hidden></div>
    `;
    card.querySelector('.studio-image-remove').addEventListener('click', () => {
      if (confirm(`Retirer l'image « ${img.name} » ?`)) removeImage(img.id);
    });
    const fitBtn = card.querySelector('.studio-image-fit-btn');
    const panel = card.querySelector('.studio-video-fit');
    fitBtn.addEventListener('click', () => {
      const show = panel.hasAttribute('hidden');
      if (show) { renderImageFitPanel(panel, img); panel.removeAttribute('hidden'); }
      else panel.setAttribute('hidden', '');
    });
    list.appendChild(card);
  });
}

// Panneau Taille + Position pour UNE image (réglages mémorisés par image).
// Calque sur le panneau de cadrage vidéo (mêmes classes CSS).
function renderImageFitPanel(panel, img) {
  const scPct = Math.round((img.scale != null ? img.scale : Math.max(0.1, Math.min(1, fullImageScale))) * 100);
  const xPct = Math.round((img.offsetX != null ? img.offsetX : 0) * 100);
  const yPct = Math.round((img.offsetY != null ? img.offsetY : 0) * 100);
  panel.innerHTML = `
    <div class="studio-video-fit-row">
      <label>Taille</label>
      <input type="range" data-imgfit="scale" min="10" max="100" step="1" value="${scPct}">
      <span class="studio-video-fit-val" data-imgfit-val="scale">${scPct} %</span>
    </div>
    <div class="studio-video-fit-row">
      <label>Position ↔</label>
      <input type="range" data-imgfit="x" min="-50" max="50" step="1" value="${xPct}">
      <span class="studio-video-fit-val" data-imgfit-val="x">${xPct} %</span>
    </div>
    <div class="studio-video-fit-row">
      <label>Position ↕</label>
      <input type="range" data-imgfit="y" min="-50" max="50" step="1" value="${yPct}">
      <span class="studio-video-fit-val" data-imgfit-val="y">${yPct} %</span>
    </div>
    <button class="studio-video-fit-reset" type="button">Réinitialiser</button>
  `;
  panel.querySelectorAll('input[type="range"]').forEach(slider => {
    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      const key = slider.dataset.imgfit;
      const val = parseInt(slider.value, 10);
      if (key === 'scale') img.scale = Math.max(0.1, Math.min(1, val / 100));
      else if (key === 'x') img.offsetX = Math.max(-0.5, Math.min(0.5, val / 100));
      else if (key === 'y') img.offsetY = Math.max(-0.5, Math.min(0.5, val / 100));
      const valEl = panel.querySelector(`[data-imgfit-val="${key}"]`);
      if (valEl) valEl.textContent = val + ' %';
      saveImgIndex();
    });
  });
  const reset = panel.querySelector('.studio-video-fit-reset');
  if (reset) reset.addEventListener('click', (e) => {
    e.stopPropagation();
    img.scale = 1; img.offsetX = 0; img.offsetY = 0;
    saveImgIndex();
    renderImageFitPanel(panel, img);
  });
}

function renderLogoOverlayUi() {
  const row = $('logoRow');
  if (!imageSources.length) { row.hidden = true; return; }
  row.hidden = false;
  const sel = $('logoOverlaySelect');
  sel.innerHTML = '';
  imageSources.forEach(img => {
    const opt = document.createElement('option');
    opt.value = img.id;
    opt.textContent = img.name;
    sel.appendChild(opt);
  });
  if (!logoOverlayId || !imageSources.some(i => i.id === logoOverlayId)) {
    logoOverlayId = imageSources[0].id;
    saveLogoCfg();
  }
  sel.value = logoOverlayId;
  $('logoOverlayToggle').checked = logoOverlayEnabled;
}

function bindImagesUi() {
  $('addImageBtn').addEventListener('click', () => $('imageFileInput').click());
  $('imageFileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) await addImageFromFile(f);
    e.target.value = '';
  });
  $('logoOverlayToggle').addEventListener('change', (e) => {
    logoOverlayEnabled = e.target.checked;
    saveLogoCfg();
  });
  $('logoOverlaySelect').addEventListener('change', (e) => {
    logoOverlayId = e.target.value;
    saveLogoCfg();
  });
}

// ============ Cartes pré-composées (image + texte) ============
function defaultCard() {
  return {
    id: '',
    name: 'Nouvelle carte',
    imageId: imageSources[0]?.id || null,
    title: '',
    subtitle: '',
    vAlign: 'center',     // top | center | bottom
    hAlign: 'center',     // left | center | right
    titleSize: 110,       // px @ 1080p
    subtitleSize: 60,
    color: '#ffffff',
    shadow: true,
    bgBox: false,
  };
}

function loadCards() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(CARDS_KEY) || '[]'); }
  catch (e) { raw = []; }
  cards.length = 0;
  let maxId = 0;
  for (const c of raw) {
    const merged = { ...defaultCard(), ...c };
    cards.push(merged);
    const n = parseInt(String(c.id || '').replace(/^c/, ''), 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  }
  nextCardId = maxId + 1;
}

function saveCards() {
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(cards)); }
  catch (e) { console.warn('saveCards failed', e); }
}

function getCardById(id) {
  return cards.find(c => c.id === id) || null;
}

function upsertCard(card) {
  if (!card.id) {
    card.id = 'c' + (nextCardId++);
    cards.push(card);
  } else {
    const idx = cards.findIndex(c => c.id === card.id);
    if (idx >= 0) cards[idx] = card;
    else cards.push(card);
  }
  saveCards();
  renderCards();
  renderScenes();
}

function removeCard(id) {
  const idx = cards.findIndex(c => c.id === id);
  if (idx < 0) return;
  const removed = cards[idx];
  cards.splice(idx, 1);
  saveCards();
  if (programScene.kind === 'card' && programScene.cardId === id) setProgramScene({ kind: 'black' });
  if (previewScene.kind === 'card' && previewScene.cardId === id) setPreviewScene({ kind: 'black' });
  renderCards();
  renderScenes();
  toast(`Carte retirée : ${removed.name}`);
}

function drawCardContent(ctx2, card, w, h) {
  // 1) Image cover (fond)
  const img = imageSources.find(i => i.id === card.imageId);
  if (img && img.imgEl) {
    const iw = img.imgEl.naturalWidth || img.imgEl.width;
    const ih = img.imgEl.naturalHeight || img.imgEl.height;
    if (iw && ih) {
      const scale = Math.max(w / iw, h / ih);
      const dw = iw * scale, dh = ih * scale;
      ctx2.drawImage(img.imgEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
  } else {
    ctx2.fillStyle = '#222';
    ctx2.fillRect(0, 0, w, h);
  }
  // 2) Texte
  const scale = h / 1080; // tailles définies en référence 1080p
  const tSize = Math.max(8, card.titleSize * scale);
  const sSize = Math.max(6, card.subtitleSize * scale);
  const lineGap = tSize * 0.25;
  const title = (card.title || '').trim();
  const subtitle = (card.subtitle || '').trim();
  if (!title && !subtitle) return;

  ctx2.textBaseline = 'middle';
  ctx2.textAlign = card.hAlign === 'left' ? 'left' : card.hAlign === 'right' ? 'right' : 'center';
  const padX = w * 0.05;
  const x = card.hAlign === 'left' ? padX : card.hAlign === 'right' ? w - padX : w / 2;

  const totalH = (title ? tSize : 0) + (subtitle ? sSize : 0) + (title && subtitle ? lineGap : 0);
  const padY = h * 0.05;
  let topY;
  if (card.vAlign === 'top') topY = padY;
  else if (card.vAlign === 'bottom') topY = h - padY - totalH;
  else topY = (h - totalH) / 2;

  if (card.bgBox) {
    ctx2.fillStyle = 'rgba(0,0,0,0.55)';
    const boxPadX = w * 0.04;
    const boxPadY = h * 0.03;
    ctx2.fillRect(0, topY - boxPadY, w, totalH + boxPadY * 2);
  }

  ctx2.fillStyle = card.color || '#ffffff';
  if (card.shadow) {
    ctx2.shadowColor = 'rgba(0,0,0,0.85)';
    ctx2.shadowBlur = Math.max(2, tSize * 0.08);
    ctx2.shadowOffsetX = 0;
    ctx2.shadowOffsetY = Math.max(1, tSize * 0.04);
  }

  let y = topY;
  if (title) {
    ctx2.font = `700 ${tSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx2.fillText(title, x, y + tSize / 2);
    y += tSize + lineGap;
  }
  if (subtitle) {
    ctx2.font = `400 ${sSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx2.fillText(subtitle, x, y + sSize / 2);
  }
  ctx2.shadowColor = 'transparent';
  ctx2.shadowBlur = 0;
  ctx2.shadowOffsetX = 0;
  ctx2.shadowOffsetY = 0;
}

function renderCards() {
  const list = $('cardsList');
  if (!list) return;
  if (!cards.length) {
    list.innerHTML = '<div class="studio-empty">Aucune carte. Crée-en une à partir d\'une image importée.</div>';
    return;
  }
  list.innerHTML = '';
  cards.forEach(c => {
    const img = imageSources.find(i => i.id === c.imageId);
    const thumbSrc = img ? img.dataUrl : '';
    const card = document.createElement('div');
    card.className = 'studio-image-card';
    const thumb = thumbSrc
      ? `<div class="studio-image-thumb" style="position:relative;">
           <img src="${thumbSrc}" alt="">
           <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px; text-align:center; padding:2px; text-shadow:0 1px 2px #000;">${escapeHtml((c.title || '').slice(0, 24))}</div>
         </div>`
      : `<div class="studio-image-thumb" style="background:#333; display:flex; align-items:center; justify-content:center; color:#888; font-size:18px;">🎴</div>`;
    card.innerHTML = `
      ${thumb}
      <div class="studio-image-meta">
        <span class="studio-image-name" title="${escapeHtml(c.name)}">🎴 ${escapeHtml(c.name)}</span>
        <button class="btn btn-sm studio-card-edit" data-id="${c.id}" title="Éditer">✎</button>
        <button class="btn btn-sm btn-danger studio-card-remove" data-id="${c.id}" title="Retirer">×</button>
      </div>
    `;
    card.querySelector('.studio-card-edit').addEventListener('click', () => openCardModal(c.id));
    card.querySelector('.studio-card-remove').addEventListener('click', () => {
      if (confirm(`Retirer la carte « ${c.name} » ?`)) removeCard(c.id);
    });
    list.appendChild(card);
  });
}

// État édition courant dans la modale
let editingCard = null;

function openCardModal(cardId) {
  if (!imageSources.length) {
    toast('Importe d\'abord au moins une image dans la section 🖼.', true);
    return;
  }
  const existing = cardId ? getCardById(cardId) : null;
  editingCard = existing ? { ...existing } : defaultCard();
  renderCardModal();
  $('cardModal').classList.add('show');
}

function closeCardModal() {
  $('cardModal').classList.remove('show');
  editingCard = null;
}

function renderCardModal() {
  if (!editingCard) return;
  // Sélecteur image
  const imgSel = $('cardImageSelect');
  imgSel.innerHTML = '';
  imageSources.forEach(img => {
    const opt = document.createElement('option');
    opt.value = img.id;
    opt.textContent = img.name;
    imgSel.appendChild(opt);
  });
  if (!imageSources.some(i => i.id === editingCard.imageId)) {
    editingCard.imageId = imageSources[0].id;
  }
  imgSel.value = editingCard.imageId;
  $('cardName').value = editingCard.name;
  $('cardTitle').value = editingCard.title;
  $('cardSubtitle').value = editingCard.subtitle;
  $('cardTitleSize').value = editingCard.titleSize;
  $('cardTitleSizeVal').textContent = editingCard.titleSize + ' px';
  $('cardSubtitleSize').value = editingCard.subtitleSize;
  $('cardSubtitleSizeVal').textContent = editingCard.subtitleSize + ' px';
  $('cardColor').value = editingCard.color;
  $('cardShadow').checked = !!editingCard.shadow;
  $('cardBgBox').checked = !!editingCard.bgBox;
  // Grille position 3x3
  document.querySelectorAll('.card-pos-cell').forEach(cell => {
    const active = cell.dataset.vAlign === editingCard.vAlign && cell.dataset.hAlign === editingCard.hAlign;
    cell.classList.toggle('active', active);
  });
  renderCardPreview();
}

function renderCardPreview() {
  if (!editingCard) return;
  const canvas = $('cardPreviewCanvas');
  if (!canvas) return;
  const ctx2 = canvas.getContext('2d');
  ctx2.fillStyle = '#000';
  ctx2.fillRect(0, 0, canvas.width, canvas.height);
  drawCardContent(ctx2, editingCard, canvas.width, canvas.height);
}

function bindCardsUi() {
  const addBtn = $('addCardBtn');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => openCardModal(null));
  $('cardModalClose').addEventListener('click', closeCardModal);
  $('cardModalCancel').addEventListener('click', closeCardModal);
  $('cardModalSave').addEventListener('click', () => {
    if (!editingCard) return;
    if (!editingCard.imageId) { toast('Choisis une image.', true); return; }
    if (!editingCard.title.trim() && !editingCard.subtitle.trim()) {
      toast('Ajoute au moins un titre ou un sous-titre.', true); return;
    }
    upsertCard(editingCard);
    toast(`Carte sauvegardée : ${editingCard.name}`);
    closeCardModal();
  });
  // Live updates
  $('cardImageSelect').addEventListener('change', (e) => { editingCard.imageId = e.target.value; renderCardPreview(); });
  $('cardName').addEventListener('input', (e) => { editingCard.name = e.target.value || 'Carte'; });
  $('cardTitle').addEventListener('input', (e) => { editingCard.title = e.target.value; renderCardPreview(); });
  $('cardSubtitle').addEventListener('input', (e) => { editingCard.subtitle = e.target.value; renderCardPreview(); });
  $('cardTitleSize').addEventListener('input', (e) => {
    editingCard.titleSize = parseInt(e.target.value, 10) || 100;
    $('cardTitleSizeVal').textContent = editingCard.titleSize + ' px';
    renderCardPreview();
  });
  $('cardSubtitleSize').addEventListener('input', (e) => {
    editingCard.subtitleSize = parseInt(e.target.value, 10) || 50;
    $('cardSubtitleSizeVal').textContent = editingCard.subtitleSize + ' px';
    renderCardPreview();
  });
  $('cardColor').addEventListener('input', (e) => { editingCard.color = e.target.value; renderCardPreview(); });
  $('cardShadow').addEventListener('change', (e) => { editingCard.shadow = e.target.checked; renderCardPreview(); });
  $('cardBgBox').addEventListener('change', (e) => { editingCard.bgBox = e.target.checked; renderCardPreview(); });
  document.querySelectorAll('.card-pos-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      editingCard.vAlign = cell.dataset.vAlign;
      editingCard.hAlign = cell.dataset.hAlign;
      document.querySelectorAll('.card-pos-cell').forEach(c => c.classList.toggle('active', c === cell));
      renderCardPreview();
    });
  });
}

// ============ Studio Mode (Preview / Program) — bindings ============
function applyStudioModeUi() {
  const monitors = $('studioMonitors');
  const previewWrap = $('previewWrap');
  const btn = $('studioModeBtn');
  if (studioMode) {
    monitors.classList.add('has-preview');
    previewWrap.hidden = false;
    btn.classList.add('active');
    btn.textContent = '🟡 Studio (preview)';
  } else {
    monitors.classList.remove('has-preview');
    previewWrap.hidden = true;
    btn.classList.remove('active');
    btn.textContent = '🔴 Direct';
  }
  renderScenes();
}
function toggleStudioMode() {
  studioMode = !studioMode;
  localStorage.setItem(STUDIO_MODE_KEY, studioMode ? '1' : '0');
  if (studioMode) {
    // Initialiser la preview avec la scène actuelle pour éviter le flash noir
    previewScene = programScene;
  }
  applyStudioModeUi();
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

function bindStudioModeUi() {
  $('studioModeBtn').addEventListener('click', toggleStudioMode);
  $('takeBtn').addEventListener('click', takeProgram);
}

// ============ Transition controls — bindings ============
function applyTransitionUi() {
  document.querySelectorAll('#transitionModes .studio-transition-mode').forEach(b => {
    b.classList.toggle('active', b.dataset.kind === transitionCfg.kind);
  });
  $('transitionDuration').value = transitionCfg.durationMs;
  $('transitionDurationVal').textContent = transitionCfg.durationMs + ' ms';
  $('transitionDurationWrap').classList.toggle('disabled', transitionCfg.kind === 'cut');
}
function bindTransitionUi() {
  document.querySelectorAll('#transitionModes .studio-transition-mode').forEach(b => {
    b.addEventListener('click', () => {
      transitionCfg.kind = TRANSITION_KINDS.includes(b.dataset.kind) ? b.dataset.kind : 'fade';
      saveTransitionCfg();
      applyTransitionUi();
      if (typeof coopBroadcast === 'function') coopBroadcast();
    });
  });
  $('transitionDuration').addEventListener('input', (e) => {
    transitionCfg.durationMs = parseInt(e.target.value, 10);
    saveTransitionCfg();
    $('transitionDurationVal').textContent = transitionCfg.durationMs + ' ms';
    if (typeof coopBroadcast === 'function') coopBroadcast();
  });
}

// ============ Caméras contribuées par co-pilots (Coop phase 2) ============
// Map call.peer -> sourceId pour pouvoir retrouver/retirer la source à la fermeture.
const coopCameraCalls = new Map();

function addCoopCameraSource(stream, info, call) {
  // Doublon (même co-pilot rappelle avec un nouveau stream) → remplace le track
  if (coopCameraCalls.has(call.peer)) {
    const prev = coopCameraCalls.get(call.peer);
    const prevSrc = sources.find(s => s.id === prev.sourceId);
    if (prevSrc) {
      prevSrc.stream = stream;
      prevSrc.videoEl.srcObject = stream;
      return;
    }
  }

  const videoEl = document.createElement('video');
  videoEl.srcObject = stream;
  videoEl.autoplay = true;
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.play().catch(() => {});

  const labelBase = info.name || 'Co-pilot';
  const label = info.deviceLabel ? `💻 ${labelBase} — ${info.deviceLabel}` : `💻 ${labelBase}`;
  const source = {
    id: 's' + (nextSourceId++),
    kind: 'remote',
    deviceId: 'coop-' + call.peer + (info.deviceLabel ? ':' + info.deviceLabel : ''),
    label,
    stream,
    videoEl,
    muted: false,
    peer: call.peer,
    coopCamera: true,
  };
  sources.push(source);
  coopCameraCalls.set(call.peer, { call, sourceId: source.id });

  call.on('close', () => removeCoopCameraSource(call));
  call.on('error', () => removeCoopCameraSource(call));

  renderSources();
  renderScenes();
  toast(`Caméra reçue : ${label}`);
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

function removeCoopCameraSource(call) {
  const entry = coopCameraCalls.get(call.peer);
  if (!entry) return;
  const src = sources.find(s => s.id === entry.sourceId);
  if (src) {
    disconnectSourceAudio(src);
    try { src.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    const idx = sources.indexOf(src);
    sources.splice(idx, 1);
  }
  coopCameraCalls.delete(call.peer);
  renderSources();
  renderScenes();
  if (src && (programScene.primaryId === src.id || programScene.secondaryId === src.id)) {
    setScene(sources.length ? { kind: 'camera', primaryId: sources[0].id } : { kind: 'black' });
  }
  toast(`${src ? src.label : 'Caméra co-pilot'} retirée`);
  if (typeof coopBroadcast === 'function') coopBroadcast();
}

// ============ Coop (multi-poste : host + co-pilot) ============
// Voir coop.js pour la couche transport PeerJS. Ici on branche le studio :
// - Host : snapshot d'état + dispatch commandes + démarrage de la session
// - Co-pilot : initCoPilot() (mode dérouté depuis init() quand ?cop=CODE)
let coopHost = null;          // instance retournée par VLCoop.startHost
let coopGuest = null;         // instance retournée par VLCoop.joinAsCoPilot
let coopBroadcastTimer = null;

function coopBroadcast() {
  // Debounce 80 ms : coalesce les bursts (renderSources + renderDestinations + setScene…)
  if (!coopHost) return;
  if (coopBroadcastTimer) return;
  coopBroadcastTimer = setTimeout(() => {
    coopBroadcastTimer = null;
    try { coopHost.broadcastState(); } catch (e) {}
  }, 80);
}

function coopStateSnapshot() {
  return {
    hostName: 'Studio principal',
    studioMode,
    programScene,
    previewScene,
    transitionCfg: { kind: transitionCfg.kind, durationMs: transitionCfg.durationMs },
    sources: sources.map(s => ({
      id: s.id, kind: s.kind, label: s.label, deviceId: s.deviceId || '',
      muted: !!s.muted, audioOn: !!s.audioOn, audioGainValue: s.audioGainValue ?? 100,
    })),
    images: (typeof imageSources !== 'undefined' ? imageSources : []).map(i => ({ id: i.id, name: i.name })),
    scenes: buildSceneList().map(s => ({ key: s.key, label: s.label, scene: s.scene })),
    // Phase 3 (failover) : on inclut url + key pour que le successeur puisse reprendre
    // la diffusion sans re-saisir les clés. Le data channel WebRTC est DTLS-chiffré.
    destinations: (typeof destinations !== 'undefined' ? destinations : []).map((d, i) => ({
      idx: i,
      name: d.name,
      url: d.url || '',
      key: d.key || '',
      placeholderKey: d.placeholderKey || '',
      enabled: !!d.enabled,
      ytBroadcastId: d.ytBroadcastId,
      status: d.status || '',
    })),
    streaming: typeof relayStreaming !== 'undefined' ? !!relayStreaming : false,
    recording: !!(mediaRecorder && mediaRecorder.state === 'recording'),
    verseState,
  };
}

function applyCoopCommand(cmd, args) {
  args = args || {};
  switch (cmd) {
    case 'setScene':
      if (args.scene) setScene(args.scene);
      break;
    case 'setProgramScene':
      if (args.scene) setProgramScene(args.scene);
      break;
    case 'setPreviewScene':
      if (args.scene) setPreviewScene(args.scene);
      break;
    case 'take':
      takeProgram();
      break;
    case 'setStudioMode':
      if (!!args.on !== !!studioMode) toggleStudioMode();
      break;
    case 'setTransitionConfig':
      if (args.cfg) {
        transitionCfg.kind = TRANSITION_KINDS.includes(args.cfg.kind) ? args.cfg.kind : 'fade';
        transitionCfg.durationMs = Math.max(0, Math.min(1000, parseInt(args.cfg.durationMs, 10) || 300));
        saveTransitionCfg();
        applyTransitionUi();
        coopBroadcast();
      }
      break;
    case 'startStream':
      if (!relayStreaming) startStreaming();
      break;
    case 'stopStream':
      if (relayStreaming) stopStreaming('coop');
      break;
    case 'startRecord':
      if (!(mediaRecorder && mediaRecorder.state === 'recording')) toggleRecord();
      break;
    case 'stopRecord':
      if (mediaRecorder && mediaRecorder.state === 'recording') toggleRecord();
      break;
    case 'showVerse':
      coopApplyVerseFromCommand(args.state || args);
      break;
    case 'clearVerse':
      coopApplyVerseFromCommand({ style: verseState?.style });
      break;
    case 'enableDestination': {
      const d = destinations[args.idx];
      if (d) { d.enabled = !!args.on; saveDestinations(); renderDestinations(); updateStreamBtnState(); }
      break;
    }
    default:
      console.warn('Coop : commande inconnue', cmd);
  }
}

function coopApplyVerseFromCommand(state) {
  // Reproduit le chemin de index.html : localStorage + BroadcastChannel + applyVerseState.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const bc = new BroadcastChannel(CHANNEL_NAME);
    if (state && (state.text || state.title)) {
      const msg = state.kind === 'title'
        ? { type: 'showTitle', payload: state }
        : { type: 'show', payload: state };
      bc.postMessage(msg);
      applyVerseState(state.kind === 'title' ? { ...state, kind: 'title' } : state);
    } else {
      bc.postMessage({ type: 'clear' });
      applyVerseState({ style: state?.style });
    }
    bc.close();
    sendCurrentVerseToTv();
  } catch (e) {
    console.warn('coop apply verse err', e);
  }
}

function coopUpdateDotUi() {
  const dot = $('coopDot');
  if (!dot) return;
  dot.classList.remove('connected', 'hosting');
  if (coopHost) dot.classList.add(coopHost.coPilotCount && coopHost.coPilotCount() > 0 ? 'connected' : 'hosting');
  else if (coopGuest) dot.classList.add('connected');
}

function coopStartHost(code) {
  if (coopHost) coopHost.stop();
  startKeepAlive(); // garde le canvas vivant en arrière-plan (sinon le flux vers les co-pilotes gèle)
  coopHost = VLCoop.startHost({
    code,
    hostName: 'Studio principal',
    programStreamFn: () => {
      if (!programStream) rebuildProgramStream();
      return programStream;
    },
    previewStreamFn: () => {
      try { return previewCanvas.captureStream(15); } catch (e) { return null; }
    },
    stateFn: coopStateSnapshot,
    onCommand: applyCoopCommand,
    onCoPilotCamera: (stream, info, call) => addCoopCameraSource(stream, info, call),
    onCoPilotChange: (count, list) => {
      const status = $('coopHostStatus');
      if (status) {
        status.textContent = count ? `${count} co-pilot${count > 1 ? 's' : ''} connecté${count > 1 ? 's' : ''}` : 'Aucun co-pilot connecté';
        status.className = 'studio-coop-status' + (count ? ' ok' : '');
      }
      const listEl = $('coopHostList');
      if (listEl) {
        if (!count) {
          listEl.innerHTML = '<div class="studio-empty">Personne connecté pour l\'instant.</div>';
        } else {
          listEl.innerHTML = list.map(c => `<div class="studio-coop-list-item">${escapeHtml(c.name || 'Co-pilot')}</div>`).join('');
        }
      }
      coopUpdateDotUi();
    },
    onStatus: (text, kind) => {
      const status = $('coopHostStatus');
      if (status) { status.textContent = text; status.className = 'studio-coop-status ' + (kind || ''); }
    },
  });
  // Affiche la zone d'info host
  const info = $('coopHostInfo');
  if (info) info.hidden = false;
  const startBtn = $('coopHostStartBtn');
  if (startBtn) startBtn.hidden = true;
  const stopBtn = $('coopHostStopBtn');
  if (stopBtn) stopBtn.hidden = false;
  const codeEl = $('coopHostCode');
  if (codeEl) codeEl.textContent = coopHost.code;
  // Lien direct
  const url = `${location.protocol}//${location.host}${location.pathname.replace(/[^/]*$/, '')}studio.html?cop=${coopHost.code}`;
  const urlEl = $('coopHostUrl');
  if (urlEl) urlEl.innerHTML = `<a href="${url}" target="_blank">${url.replace(/^https?:\/\//, '')}</a>`;
  // QR
  const qrEl = $('coopHostQr');
  if (qrEl) {
    qrEl.innerHTML = '';
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1 });
    } catch (e) {}
  }
  coopUpdateDotUi();
}

function coopStopHost() {
  if (!coopHost) return;
  coopHost.stop();
  coopHost = null;
  const info = $('coopHostInfo');
  if (info) info.hidden = true;
  const startBtn = $('coopHostStartBtn');
  if (startBtn) startBtn.hidden = false;
  const stopBtn = $('coopHostStopBtn');
  if (stopBtn) stopBtn.hidden = true;
  const status = $('coopHostStatus');
  if (status) { status.textContent = 'Hors-ligne'; status.className = 'studio-coop-status'; }
  coopUpdateDotUi();
}

function bindCoopUi() {
  const openBtn = $('openCoopBtn');
  const modal = $('coopModal');
  if (!openBtn || !modal) return;
  openBtn.addEventListener('click', () => modal.classList.add('show'));
  $('coopModalClose').addEventListener('click', () => modal.classList.remove('show'));
  $('coopModalOk').addEventListener('click', () => modal.classList.remove('show'));

  // Tabs
  document.querySelectorAll('#coopTabs .studio-coop-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab;
      document.querySelectorAll('#coopTabs .studio-coop-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.studio-coop-pane').forEach(p => p.hidden = p.dataset.pane !== which);
    });
  });

  // Host start/stop
  $('coopHostStartBtn').addEventListener('click', () => coopStartHost());
  $('coopHostStopBtn').addEventListener('click', () => coopStopHost());
  $('coopHostCopyBtn').addEventListener('click', () => {
    const a = $('coopHostUrl').querySelector('a');
    if (a) navigator.clipboard?.writeText(a.href).then(() => toast('Lien copié')).catch(() => {});
  });

  // Join : redirige vers studio.html?cop=CODE (mode co-pilot = nouveau chargement de page)
  $('coopJoinBtn').addEventListener('click', () => {
    const code = ($('coopJoinCode').value || '').toUpperCase().trim();
    const name = ($('coopJoinName').value || '').trim();
    if (!code || code.length !== 4) {
      const s = $('coopJoinStatus'); s.textContent = 'Saisis un code de 4 caractères.'; s.className = 'studio-coop-join-status err';
      return;
    }
    const params = new URLSearchParams();
    params.set('cop', code);
    if (name) params.set('name', name);
    location.search = '?' + params.toString();
  });
}

// ============ Mode CO-PILOT (UI dérouté) ============
// Branché depuis init() quand ?cop=CODE est présent. On NE lance PAS le studio
// local (pas de caméras, pas de rendu canvas, pas de signaling phones). Le
// co-pilot reçoit Program+Preview en WebRTC + l'état complet en data channel.
let coopRemoteState = null;

async function initCoPilot(code, name) {
  document.body.classList.add('coop-mode');
  const banner = $('coopBanner');
  const sub = $('coopBannerSub');
  if (banner) banner.hidden = false;
  if (sub) sub.textContent = `Code ${code} · connexion en cours…`;

  // Bindings minimaux : modale (pour rebascule éventuelle) + boutons UI partagés
  try { bindCoopUi(); } catch (e) {}

  // Branche les boutons studio en mode "envoie commande"
  $('studioModeBtn').addEventListener('click', () => coopGuest && coopGuest.sendCommand('setStudioMode', { on: !coopRemoteState?.studioMode }));
  $('takeBtn').addEventListener('click', () => coopGuest && coopGuest.sendCommand('take'));
  $('recordBtn').addEventListener('click', () => coopGuest && coopGuest.sendCommand(coopRemoteState?.recording ? 'stopRecord' : 'startRecord'));
  // Stream button (s'il existe)
  const streamBtn = $('streamBtn');
  if (streamBtn) streamBtn.addEventListener('click', () => coopGuest && coopGuest.sendCommand(coopRemoteState?.streaming ? 'stopStream' : 'startStream'));
  // Transition
  document.querySelectorAll('#transitionModes .studio-transition-mode').forEach(b => {
    b.addEventListener('click', () => {
      const kind = b.dataset.kind === 'cut' ? 'cut' : 'fade';
      const dur = parseInt($('transitionDuration').value, 10) || 300;
      coopGuest && coopGuest.sendCommand('setTransitionConfig', { cfg: { kind, durationMs: dur } });
    });
  });
  $('transitionDuration').addEventListener('change', (e) => {
    const dur = parseInt(e.target.value, 10) || 300;
    coopGuest && coopGuest.sendCommand('setTransitionConfig', { cfg: { kind: transitionCfgKindFromUi(), durationMs: dur } });
  });
  // Quitter
  const leaveBtn = $('coopLeaveBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', () => {
    // Annule un éventuel take-over en attente avant de fermer
    if (coopFailoverTimer) { clearTimeout(coopFailoverTimer); coopFailoverTimer = null; }
    if (coopFailoverCountdownTimer) { clearInterval(coopFailoverCountdownTimer); coopFailoverCountdownTimer = null; }
    coopStopAllSharedCameras();
    coopGuest && coopGuest.leave();
    coopGuest = null;
    location.href = location.pathname;
  });

  // Partage caméra locale → host (phase 2)
  const shareSection = $('coopShareSection');
  if (shareSection) shareSection.hidden = false;
  $('coopCameraRefreshBtn').addEventListener('click', () => coopRefreshCameraList(true));
  $('coopCameraSelect').addEventListener('change', (e) => {
    $('coopCameraShareBtn').disabled = !e.target.value;
  });
  $('coopCameraShareBtn').addEventListener('click', () => {
    const deviceId = $('coopCameraSelect').value;
    const label = $('coopCameraSelect').selectedOptions[0]?.text || '';
    if (deviceId) coopShareLocalCamera(deviceId, label);
  });
  coopRefreshCameraList(false);

  // Connexion
  coopGuest = VLCoop.joinAsCoPilot(code, {
    name: name || 'Co-pilot',
    onStatus: (text, kind) => {
      if (sub) sub.textContent = `Code ${code} · ${text}`;
      const dot = $('coopDot'); if (dot) dot.classList.toggle('connected', kind === 'ok');
    },
    onHello: ({ hostName }) => {
      if (sub) sub.textContent = `Connecté à ${hostName || 'host'} (${code})`;
    },
    onProgramStream: (stream) => {
      const v = $('coopProgramVideo');
      if (v) { v.srcObject = stream; v.play().catch(() => {}); }
    },
    onPreviewStream: (stream) => {
      const v = $('coopPreviewVideo');
      if (v) { v.srcObject = stream; v.play().catch(() => {}); }
    },
    onState: (state) => {
      coopRemoteState = state;
      coopRenderRemoteState(state);
    },
    onToast: (msg, isError) => toast(msg, isError),
    // Phase 3 : failover
    onHostLost: ({ myPeerId, coPilotIds, lastState }) => coopHandleHostLost({ myPeerId, coPilotIds, lastState, code }),
    onHostBack: () => coopHandleHostBack(),
  });
}

// ============ Failover phase 3 ============
// État de l'élection en cours. Quand on devient "host lost", on calcule un délai
// avant de tenter la bascule en fonction de notre position dans la liste des
// co-pilots (la plus ancienne en premier). Si quelqu'un d'autre réussit avant
// nous, le watchdog revoit un heartbeat et onHostBack() annule le take-over.
let coopFailoverTimer = null;
let coopFailoverDeadline = 0;
let coopFailoverCountdownTimer = null;

function coopHandleHostLost({ myPeerId, coPilotIds, lastState, code }) {
  // Calcule le rang : oldest first (ordre d'insertion). Si on n'est pas dans la
  // liste (heartbeat jamais reçu), on prend la pire place + délai max.
  const ids = Array.isArray(coPilotIds) ? coPilotIds : [];
  let myRank = ids.indexOf(myPeerId);
  if (myRank < 0) myRank = ids.length;
  // Délai : 3 s pour le rang 0, +5 s par rang suivant. Garde-fou 30 s.
  // Suffisamment large pour qu'un take-over en cours (reload + init ~5 s) ait
  // le temps de revenir comme host avant que le rang suivant ne tente aussi.
  const delayMs = Math.min(30000, 3000 + myRank * 5000);
  coopFailoverDeadline = Date.now() + delayMs;
  coopShowFailoverBanner(myRank);
  if (coopFailoverTimer) clearTimeout(coopFailoverTimer);
  coopFailoverTimer = setTimeout(() => {
    coopFailoverTimer = null;
    // Re-check : le host est-il revenu entre temps ?
    if (!coopGuest) return;
    coopTakeOver(code, lastState || coopRemoteState);
  }, delayMs);
  // Countdown UI
  if (coopFailoverCountdownTimer) clearInterval(coopFailoverCountdownTimer);
  coopFailoverCountdownTimer = setInterval(() => {
    const sec = Math.max(0, Math.ceil((coopFailoverDeadline - Date.now()) / 1000));
    const el = $('coopFailoverCountdown');
    if (el) el.textContent = sec > 0 ? `Reprise dans ${sec} s…` : 'Reprise en cours…';
  }, 250);
}

function coopHandleHostBack() {
  if (coopFailoverTimer) { clearTimeout(coopFailoverTimer); coopFailoverTimer = null; }
  if (coopFailoverCountdownTimer) { clearInterval(coopFailoverCountdownTimer); coopFailoverCountdownTimer = null; }
  coopHideFailoverBanner();
}

function coopShowFailoverBanner(myRank) {
  const el = $('coopFailoverBanner');
  if (!el) return;
  el.hidden = false;
  const sub = $('coopFailoverSub');
  if (sub) sub.textContent = myRank === 0
    ? 'Tu es le co-pilot le plus ancien : tu vas reprendre la main.'
    : `${myRank} co-pilot${myRank > 1 ? 's' : ''} plus ancien${myRank > 1 ? 's' : ''} tentera la reprise avant toi.`;
  const cd = $('coopFailoverCountdown');
  if (cd) cd.textContent = '…';
}

function coopHideFailoverBanner() {
  const el = $('coopFailoverBanner');
  if (el) el.hidden = true;
}

// Bascule le co-pilot en host. On stash le snapshot dans sessionStorage puis on
// recharge la page sans ?cop= → la séquence init() normale tourne, et à la fin
// elle démarre VLCoop.startHost avec le même code. Les autres co-pilots, qui
// retentent peer.connect en boucle, se reconnectent automatiquement.
function coopTakeOver(code, snapshot) {
  if (!snapshot) snapshot = coopRemoteState || {};
  try {
    // Pousse les pièces "restaurables" dans le localStorage local
    // (l'init normal les rechargera comme s'il s'agissait d'une session locale).
    if (snapshot.verseState !== undefined) {
      try {
        if (snapshot.verseState === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.verseState));
      } catch (e) {}
    }
    if (snapshot.transitionCfg) {
      try { localStorage.setItem(TRANSITION_KEY, JSON.stringify(snapshot.transitionCfg)); } catch (e) {}
    }
    if (snapshot.studioMode !== undefined) {
      try { localStorage.setItem(STUDIO_MODE_KEY, snapshot.studioMode ? '1' : '0'); } catch (e) {}
    }
    if (Array.isArray(snapshot.destinations) && snapshot.destinations.length) {
      // Reconstruit un format compatible avec loadDestinations()
      const restored = snapshot.destinations.map(d => ({
        name: d.name || 'Destination',
        url: d.url || '',
        key: d.key || '',
        placeholderKey: d.placeholderKey || '',
        enabled: !!d.enabled,
        ytBroadcastId: d.ytBroadcastId,
      }));
      try { localStorage.setItem(DEST_STORAGE_KEY, JSON.stringify(restored)); } catch (e) {}
    }
    // Marque la session : init() détectera ce flag et fera coopStartHost(code).
    sessionStorage.setItem('versetlive:coop-takeover', code);
  } catch (e) { console.warn('coopTakeOver state stash err', e); }
  // Coupe le guest et les caméras partagées avant rechargement
  try { coopStopAllSharedCameras(); } catch (e) {}
  try { coopGuest && coopGuest.leave(); } catch (e) {}
  coopGuest = null;
  // Recharge la page en mode host normal (URL sans ?cop=)
  const url = location.pathname;
  location.href = url;
}

function transitionCfgKindFromUi() {
  const active = document.querySelector('#transitionModes .studio-transition-mode.active');
  return active && active.dataset.kind === 'cut' ? 'cut' : 'fade';
}

// ---- Phase 2 : partage caméra du co-pilot vers le host ----
const coopSharedCameras = new Map(); // deviceId -> { call, stream, label }

async function coopRefreshCameraList(promptPermission) {
  const sel = $('coopCameraSelect');
  if (!sel) return;
  // Pour obtenir les labels, il faut au moins un getUserMedia accordé.
  if (promptPermission) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach(t => t.stop());
    } catch (e) {
      toast('Accès caméra refusé : ' + e.message, true);
      return;
    }
  }
  sel.innerHTML = '<option value="">— Choisir une caméra —</option>';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    if (!cams.length) {
      sel.innerHTML = '<option value="">— Aucune caméra détectée —</option>';
      return;
    }
    cams.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Caméra ${i + 1} (autoriser pour le nom)`;
      if (coopSharedCameras.has(d.deviceId)) {
        opt.disabled = true;
        opt.textContent = '✅ ' + opt.textContent + ' — partagée';
      }
      sel.appendChild(opt);
    });
  } catch (e) {
    console.warn('enumerateDevices err', e);
  }
}

async function coopShareLocalCamera(deviceId, label) {
  if (coopSharedCameras.has(deviceId)) { toast('Caméra déjà partagée'); return; }
  if (!coopGuest) { toast('Pas connecté au host', true); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const trackLabel = stream.getVideoTracks()[0]?.label || label || 'Caméra';
    const cleanLabel = String(label || trackLabel).replace(/\s*\(autoriser.*$/, '').replace(/^[✅⬜]\s*/, '').trim();
    const call = coopGuest.shareCamera(stream, { deviceLabel: cleanLabel });
    if (!call) {
      stream.getTracks().forEach(t => t.stop());
      toast('Impossible d\'appeler le host', true);
      return;
    }
    coopSharedCameras.set(deviceId, { call, stream, label: cleanLabel });
    call.on('close', () => {
      const entry = coopSharedCameras.get(deviceId);
      if (entry) {
        try { entry.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        coopSharedCameras.delete(deviceId);
        coopRenderSharedList();
        coopRefreshCameraList(false);
      }
    });
    coopRenderSharedList();
    coopRefreshCameraList(false);
    toast(`Caméra partagée : ${cleanLabel}`);
  } catch (e) {
    toast('Impossible d\'accéder à la caméra : ' + e.message, true);
  }
}

function coopStopShareLocalCamera(deviceId) {
  const entry = coopSharedCameras.get(deviceId);
  if (!entry) return;
  try { entry.call.close(); } catch (e) {}
  try { entry.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  coopSharedCameras.delete(deviceId);
  coopRenderSharedList();
  coopRefreshCameraList(false);
}

function coopStopAllSharedCameras() {
  Array.from(coopSharedCameras.keys()).forEach(coopStopShareLocalCamera);
}

function coopRenderSharedList() {
  const list = $('coopSharedList');
  if (!list) return;
  if (!coopSharedCameras.size) { list.innerHTML = ''; return; }
  list.innerHTML = '';
  coopSharedCameras.forEach((entry, deviceId) => {
    const row = document.createElement('div');
    row.className = 'studio-coop-shared-item';
    row.innerHTML = `<span class="studio-coop-shared-item-label">🎥 ${escapeHtml(entry.label || 'Caméra')}</span><button class="btn btn-sm" data-stop="${escapeHtml(deviceId)}">Stop</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-stop]').forEach(b => {
    b.addEventListener('click', () => coopStopShareLocalCamera(b.dataset.stop));
  });
}

function coopRenderRemoteState(state) {
  // Studio mode UI
  const monitors = $('studioMonitors');
  const previewWrap = $('previewWrap');
  const modeBtn = $('studioModeBtn');
  if (state.studioMode) {
    monitors.classList.add('has-preview');
    previewWrap.hidden = false;
    modeBtn.classList.add('active');
    modeBtn.textContent = '🟡 Studio (preview)';
  } else {
    monitors.classList.remove('has-preview');
    previewWrap.hidden = true;
    modeBtn.classList.remove('active');
    modeBtn.textContent = '🔴 Direct';
  }

  // Transition
  if (state.transitionCfg) {
    document.querySelectorAll('#transitionModes .studio-transition-mode').forEach(b => {
      b.classList.toggle('active', b.dataset.kind === state.transitionCfg.kind);
    });
    $('transitionDuration').value = state.transitionCfg.durationMs;
    $('transitionDurationVal').textContent = state.transitionCfg.durationMs + ' ms';
  }

  // Scène list
  const list = $('scenesList');
  const scenesArr = state.scenes || [];
  if (!scenesArr.length) {
    list.innerHTML = '<div class="studio-empty">Aucune scène côté host.</div>';
  } else {
    const progKey = sceneKey(state.programScene);
    const prevKey = sceneKey(state.previewScene);
    list.innerHTML = '';
    scenesArr.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'studio-scene-btn';
      btn.textContent = s.label;
      if (progKey === s.key) btn.classList.add('active');
      if (state.studioMode && prevKey === s.key && progKey !== s.key) btn.classList.add('preview-active');
      btn.addEventListener('click', () => coopGuest && coopGuest.sendCommand('setScene', { scene: s.scene }));
      list.appendChild(btn);
    });
  }

  // Stream/record status (visuel topbar)
  const statusEl = $('studioStatus');
  if (statusEl) statusEl.textContent = state.streaming ? '● Diffusion en direct' : (state.recording ? '⏺ Enregistrement…' : 'Co-pilot');
  const recBtn = $('recordBtn');
  if (recBtn) {
    recBtn.textContent = state.recording ? '⏹ Arrêter l\'enreg.' : '⏺ Enregistrer';
    recBtn.classList.toggle('btn-danger', !state.recording);
    recBtn.classList.toggle('btn-success', !!state.recording);
  }

  // Stream button : drivé par l'état du host (le relais RTMP tourne côté host)
  const streamBtn = $('streamBtn');
  if (streamBtn) {
    if (state.streaming) {
      streamBtn.disabled = false;
      streamBtn.textContent = '⏹ Arrêter le stream (host)';
      streamBtn.classList.remove('btn-primary');
      streamBtn.classList.add('btn-danger');
    } else {
      const activeDests = (state.destinations || []).filter(d => d.enabled).length;
      streamBtn.disabled = activeDests === 0;
      streamBtn.textContent = activeDests
        ? `▶ Démarrer le stream (${activeDests} destination${activeDests > 1 ? 's' : ''})`
        : '▶ Démarrer le stream (aucune destination)';
      streamBtn.classList.add('btn-primary');
      streamBtn.classList.remove('btn-danger');
    }
  }

  // Liste destinations en lecture seule (le host gère réellement le relais)
  const destList = $('destinationsList');
  if (destList) {
    const dests = state.destinations || [];
    if (!dests.length) {
      destList.innerHTML = '<div class="studio-empty">Aucune destination — à configurer sur l\'ordi host.</div>';
    } else {
      destList.innerHTML = dests.map(d => `
        <div class="studio-destination" style="opacity:${d.enabled ? 1 : 0.5}">
          <span>${d.enabled ? '✅' : '⬜'} ${escapeHtml(d.name)}</span>
          ${d.status ? `<span class="studio-destination-status">${escapeHtml(d.status)}</span>` : ''}
        </div>
      `).join('');
    }
  }

  // Cache les boutons d'édition (add destination, relay help) en mode co-pilot
  const addDest = $('addDestBtn'); if (addDest) addDest.style.display = 'none';
  const relayHelp = $('relayHelp'); if (relayHelp) relayHelp.style.display = 'none';
  const relayPill = $('relayPill'); if (relayPill) relayPill.style.display = 'none';

  // Verset status (panneau dédié si présent)
  try { verseState = state.verseState; renderVerseStatus(); } catch (e) {}
}

// ============ Boot ============
// ===== Liaison UI de la bande d'annonce =====
function bindTicker() {
  const toggle = $('tickerToggle');
  if (!toggle) return;
  const messages = $('tickerMessages');
  const speed = $('tickerSpeed');
  const speedVal = $('tickerSpeedVal');
  const bg = $('tickerBgColor');
  const txt = $('tickerTextColor');

  // Initialise l'UI depuis la config persistée.
  toggle.checked = tickerCfg.enabled;
  if (messages) messages.value = tickerCfg.messages.join('\n');
  if (speed) speed.value = tickerCfg.speed;
  if (speedVal) speedVal.textContent = tickerCfg.speed;
  if (bg) bg.value = tickerCfg.bgColor;
  if (txt) txt.value = tickerCfg.textColor;

  toggle.addEventListener('change', () => { tickerCfg.enabled = toggle.checked; saveTickerCfg(); });
  if (messages) messages.addEventListener('input', () => {
    tickerCfg.messages = messages.value.split('\n').map(s => s.trim()).filter(Boolean);
    saveTickerCfg();
  });
  if (speed) speed.addEventListener('input', () => {
    tickerCfg.speed = Math.max(20, Math.min(400, parseInt(speed.value, 10) || 100));
    if (speedVal) speedVal.textContent = tickerCfg.speed;
    saveTickerCfg();
  });
  if (bg) bg.addEventListener('input', () => { tickerCfg.bgColor = bg.value; saveTickerCfg(); });
  if (txt) txt.addEventListener('input', () => { tickerCfg.textColor = txt.value; saveTickerCfg(); });

  // Taille de police + épaisseur (graisse) du texte de l'annonce.
  const fontScale = $('tickerFontScale');
  const fontScaleVal = $('tickerFontScaleVal');
  const weight = $('tickerWeight');
  const weightVal = $('tickerWeightVal');
  if (fontScale) fontScale.value = Math.round((tickerCfg.fontScale || 1) * 100);
  if (fontScaleVal) fontScaleVal.textContent = Math.round((tickerCfg.fontScale || 1) * 100) + '%';
  if (weight) weight.value = tickerCfg.weight || 600;
  if (weightVal) weightVal.textContent = tickerCfg.weight || 600;
  if (fontScale) fontScale.addEventListener('input', () => {
    tickerCfg.fontScale = Math.max(0.5, Math.min(2.5, (parseInt(fontScale.value, 10) || 100) / 100));
    if (fontScaleVal) fontScaleVal.textContent = Math.round(tickerCfg.fontScale * 100) + '%';
    saveTickerCfg();
  });
  if (weight) weight.addEventListener('input', () => {
    tickerCfg.weight = Math.max(400, Math.min(900, parseInt(weight.value, 10) || 600));
    if (weightVal) weightVal.textContent = tickerCfg.weight;
    saveTickerCfg();
  });

  // Position verticale de la bande (0 = bas, 100 = haut).
  const posY = $('tickerPosY');
  const posYVal = $('tickerPosYVal');
  const posYLabel = (p) => p <= 0.01 ? 'bas' : p >= 0.99 ? 'haut' : Math.round(p * 100) + '%';
  if (posY) posY.value = Math.round((tickerCfg.posY || 0) * 100);
  if (posYVal) posYVal.textContent = posYLabel(tickerCfg.posY || 0);
  if (posY) posY.addEventListener('input', () => {
    tickerCfg.posY = Math.max(0, Math.min(1, (parseInt(posY.value, 10) || 0) / 100));
    if (posYVal) posYVal.textContent = posYLabel(tickerCfg.posY);
    saveTickerCfg();
  });

  // Contrôle manuel : préc. / pause / suiv. (le défilement reste auto par défaut).
  const prevBtn = $('tickerPrevBtn');
  const nextBtn = $('tickerNextBtn');
  const pauseBtn = $('tickerPauseBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => tickerJump(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => tickerJump(1));
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    tickerSetPaused(!tickerPaused);
    pauseBtn.textContent = tickerPaused ? '▶ Lire' : '⏸ Pause';
  });
}

async function init() {
  // Mode co-pilot : ?cop=CODE → on dévie complètement le boot
  const params = new URLSearchParams(location.search);
  const copCode = (params.get('cop') || '').toUpperCase().trim();
  if (copCode && copCode.length === 4) {
    // Bindings minimaux ; pas de caméras, pas de signaling phones, pas de bindStudioModeUi/Transition
    // (initCoPilot installe ses propres listeners qui envoient des commandes au host)
    renderVerseStatus();
    await initCoPilot(copCode, params.get('name') || '');
    return;
  }

  bindUi();
  bindRemoteHelp();
  bindTvUi();
  bindOutputsPanel();
  bindStreaming();
  bindShortcuts();
  bindImagesUi();
  bindCardsUi();
  bindStudioModeUi();
  bindTransitionUi();
  bindCoopUi();
  bindVerseNav();
  bindSongNav();
  bindQualitySelector();
  bindTextStudio();
  bindSelectionUi();
  bindTicker();
  applyStudioModeUi();
  applyTransitionUi();
  // Init module intro/outro (chargement assets IndexedDB + bind modal)
  if (window.IntroOutro) {
    window.IntroOutro.init({ onChange: () => renderScenes() });
  }
  // Init vidéothèque : expose une mini API setScene pour que videos.js trigger les scènes
  window.__studioApi = { setScene };
  if (window.VideoLibrary) {
    await window.VideoLibrary.init({
      onChange: () => renderScenes(),
      onVideoEnded: () => {
        // En diaporama : la fin de la vidéo déclenche l'élément suivant.
        if (slideshow) { slideshowNext(); return; }
        // Retour automatique à la scène avant la vidéo
        if (preVideoScene) {
          const back = preVideoScene;
          preVideoScene = null;
          setProgramScene(back);
        } else {
          setProgramScene({ kind: 'black' });
        }
      }
    });
  }
  renderScenes();
  renderVerseStatus();
  renderDestinations();
  startAudioMeter();
  startSourceVuLoop();
  requestAnimationFrame(renderFrame);
  startBgRenderLoop();
  startPerfHud();
  rebuildProgramStream();
  await refreshDeviceList();
  loadStoredImages();
  initSignaling();
  connectRelay();

  // Phase 3 : si on vient d'un take-over coop, on relance la session host avec
  // le code initial pour que les autres co-pilots se reconnectent automatiquement.
  let takeoverCode = '';
  try { takeoverCode = sessionStorage.getItem('versetlive:coop-takeover') || ''; } catch (e) {}
  if (takeoverCode && takeoverCode.length === 4) {
    try { sessionStorage.removeItem('versetlive:coop-takeover'); } catch (e) {}
    setTimeout(() => {
      try {
        coopStartHost(takeoverCode);
        toast(`Tu es désormais le host (${takeoverCode}). Reconnecte tes caméras puis relance le stream.`, false);
        const modal = $('coopModal');
        if (modal) modal.classList.add('show');
      } catch (e) { console.warn('takeover host start err', e); }
      // Filet de secours : si dans 4 s le code est déjà pris (un autre co-pilot
      // a basculé avant nous), on retombe en co-pilot pour rejoindre le nouveau host.
      setTimeout(() => {
        const status = $('coopHostStatus');
        const txt = (status && status.textContent) || '';
        if (/d[ée]j[àa] pris/i.test(txt)) {
          toast('Un autre co-pilot a pris la main. Reconnexion…', false);
          location.href = location.pathname + '?cop=' + encodeURIComponent(takeoverCode);
        }
      }, 4000);
    }, 500);
  }
}
init();

// ============ Lien live vers le panneau principal (index.html) ============
// Push d'état toutes les 2 s sur 'versetlive:studio-link'. Le panneau écoute
// et met à jour le mini-bloc 🎬 Studio (intégré) sans aucun OBS WebSocket.
(function () {
  let bc;
  try { bc = new BroadcastChannel('versetlive:studio-link'); }
  catch (e) { return; }
  function currentSceneLabel() {
    try {
      const list = buildSceneList();
      const match = list.find(item => sceneKey(item.scene) === sceneKey(programScene));
      return match ? match.label : (programScene?.kind || 'Noir');
    } catch (e) { return 'Noir'; }
  }
  function push() {
    try {
      bc.postMessage({
        type: 'state',
        state: {
          sceneLabel: currentSceneLabel(),
          streaming: typeof relayStreaming !== 'undefined' ? !!relayStreaming : false,
          recording: !!(mediaRecorder && mediaRecorder.state === 'recording'),
          studioMode: !!studioMode,
        },
      });
    } catch (e) {}
  }
  setInterval(push, 2000);
  setTimeout(push, 500);
  window.addEventListener('beforeunload', () => {
    try { bc.postMessage({ type: 'close' }); } catch (e) {}
    try { bc.close(); } catch (e) {}
  });
})();

// Pont public pour modules externes (ex: youtube-scheduler)
window.VL = {
  addDestination(d) {
    if (!d?.url || !d?.key) return false;
    destinations.push({
      name: d.name || 'Destination',
      url: d.url,
      key: d.key,
      enabled: d.enabled !== false,
      ytBroadcastId: d.ytBroadcastId || undefined,
    });
    saveDestinations();
    renderDestinations();
    updateStreamBtnState();
    return true;
  },
  hasDestination(broadcastId) {
    return destinations.some(d => d.ytBroadcastId === broadcastId);
  },
  enableDestination(broadcastId) {
    const d = destinations.find(x => x.ytBroadcastId === broadcastId);
    if (!d) return false;
    d.enabled = true;
    saveDestinations();
    renderDestinations();
    updateStreamBtnState();
    return true;
  },
  startStream() {
    if (!relayStreaming) startStreaming();
  },
  stopStream() {
    if (relayStreaming) stopStreaming('user');
  },
  isStreaming() { return !!relayStreaming; },
};
