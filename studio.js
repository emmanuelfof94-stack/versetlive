// Studio VersetLive — Phase 1
// Mixeur multi-caméras USB, sortie projecteur, enregistrement local.
// Partage l'état du verset avec index.html via BroadcastChannel + localStorage.

const CHANNEL_NAME = 'versetlive';
const STORAGE_KEY = 'versetlive:state';
const OUTPUT_W = 1920;
const OUTPUT_H = 1080;
const OUTPUT_FPS = 30;

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
let logoOverlayId = null; // image id utilisée en overlay coin
let logoOverlayEnabled = false;

// Scène active : { kind, primaryId?, secondaryId? }
//   kind ∈ { 'camera', 'camera+verse', 'pip', 'image', 'image+verse', 'verse', 'intro', 'outro', 'black' }
let programScene = { kind: 'black' };
let previewScene = { kind: 'black' };
let previousProgramScene = null;
let transitionStart = 0;

// Configuration transition (persistée)
const TRANSITION_KEY = 'versetlive:transition';
let transitionCfg = loadTransitionCfg();

// Studio Mode (Preview/Program). Off par défaut = clic scène → direct.
const STUDIO_MODE_KEY = 'versetlive:studio-mode';
let studioMode = localStorage.getItem(STUDIO_MODE_KEY) === '1';

// Filtres par source (persistés par deviceId)
const FILTERS_KEY = 'versetlive:filters';
let filtersStore = loadFiltersStore(); // { [deviceId]: { mirror, brightness, contrast, saturation } }
const openFilterPanels = new Set(); // sourceIds dont le panneau filtres est ouvert

let verseState = null;

function loadTransitionCfg() {
  try {
    const raw = localStorage.getItem(TRANSITION_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      return { kind: c.kind === 'cut' ? 'cut' : 'fade', durationMs: Math.max(0, Math.min(2000, c.durationMs ?? 300)) };
    }
  } catch (e) {}
  return { kind: 'fade', durationMs: 300 };
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
  return { mirror: false, brightness: 100, contrast: 100, saturation: 100 };
}
function getFiltersFor(source) {
  const key = source.deviceId || source.id;
  if (!filtersStore[key]) filtersStore[key] = defaultFilters();
  return filtersStore[key];
}
function hasNonDefaultFilter(f) {
  return f.mirror || f.brightness !== 100 || f.contrast !== 100 || f.saturation !== 100;
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
        <div class="studio-source-filter-actions">
          <button class="btn btn-sm" data-action="filter-reset">Réinitialiser</button>
        </div>
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
      } else if (t.dataset.action === 'volume') {
        const v = parseInt(t.value, 10);
        s.audioGainValue = v / 100;
        if (s.audioGain) s.audioGain.gain.value = s.audioGainValue;
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
  list.push({ key: 'black', label: 'Noir', scene: { kind: 'black' } });
  return list;
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
    const btn = document.createElement('button');
    btn.className = 'studio-scene-btn';
    btn.textContent = s.label;
    if (progKey === s.key) btn.classList.add('active');
    if (studioMode && prevKey === s.key && progKey !== s.key) btn.classList.add('preview-active');
    btn.addEventListener('click', () => setScene(s.scene));
    list.appendChild(btn);
  });
}

function sceneKey(scene) {
  if (!scene) return 'black';
  if (scene.kind === 'camera') return `cam-${scene.primaryId}`;
  if (scene.kind === 'camera+verse') return `cam-verse-${scene.primaryId}`;
  if (scene.kind === 'image') return `img-${scene.imageId}`;
  if (scene.kind === 'image+verse') return `img-verse-${scene.imageId}`;
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
  if (filters && hasNonDefaultFilter(filters)) {
    activeCtx.save();
    activeCtx.filter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturation}%)`;
    if (filters.mirror) {
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
  const { x, y, w, h } = area;

  // Fond du verset
  const style = verseState.style || {};
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
  // 4.5vw → en px sur 1920 = 4.5/100 * 1920 = 86.4
  const fontSizePx = Math.round((fontSizeVw / 100) * OUTPUT_W);
  const refSizePx = Math.max(Math.round(fontSizePx * 0.5), 28);
  const color = style.textColor || '#ffffff';
  const align = style.textAlign || 'center';

  activeCtx.fillStyle = color;
  activeCtx.textAlign = align;
  activeCtx.textBaseline = 'middle';

  // Position alignement
  const padX = w * 0.05;
  const padY = h * 0.08;
  const textX = align === 'left' ? x + padX : align === 'right' ? x + w - padX : x + w / 2;

  // Ombre
  applyShadow(style.textShadow || 'soft');

  // Verset (multi-lignes en respectant la largeur)
  if (verseState.kind === 'title') {
    drawTitle(verseState, x, y, w, h, fontSizePx, fontFamily, color, align);
  } else if (text) {
    const lines = wrapText('« ' + text + ' »', w - padX * 2, fontSizePx, fontFamily);
    const lineHeight = fontSizePx * 1.25;
    const totalH = lines.length * lineHeight + (ref ? refSizePx * 1.8 : 0);
    const vAlign = style.vAlign || 'center';
    let startY;
    if (vAlign === 'top') startY = y + padY + lineHeight / 2;
    else if (vAlign === 'bottom') startY = y + h - padY - totalH + lineHeight / 2;
    else startY = y + (h - totalH) / 2 + lineHeight / 2;

    activeCtx.font = `${fontSizePx}px ${fontFamily}`;
    lines.forEach((line, i) => activeCtx.fillText(line, textX, startY + i * lineHeight));

    // Référence
    if (ref && (style.showRef || 'below') !== 'hide') {
      activeCtx.font = `italic ${refSizePx}px ${fontFamily}`;
      const refY = (style.showRef === 'above')
        ? startY - lineHeight
        : startY + lines.length * lineHeight + refSizePx * 0.3;
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

function setProgramScene(scene) {
  if (sceneKey(programScene) === sceneKey(scene)) return;
  previousProgramScene = programScene;
  programScene = scene;
  transitionStart = performance.now();
  renderScenes();
  // Trigger audio MP3 de l'intro/outro si applicable
  if (window.IntroOutro) window.IntroOutro.onSceneChange(scene);
}

function setPreviewScene(scene) {
  previewScene = scene;
  renderScenes();
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
    if (img && img.imgEl) drawImageContain(img.imgEl, 0, 0, OUTPUT_W, OUTPUT_H);
    if (s.kind === 'image+verse') {
      const h = OUTPUT_H * 0.30;
      activeCtx.fillStyle = 'rgba(0,0,0,0.55)';
      activeCtx.fillRect(0, OUTPUT_H - h, OUTPUT_W, h);
      drawVerseOverlay({ x: 0, y: OUTPUT_H - h, w: OUTPUT_W, h });
    }
  } else if (s.kind === 'verse') {
    drawVerseOverlay({ x: 0, y: 0, w: OUTPUT_W, h: OUTPUT_H });
  } else if (s.kind === 'intro' || s.kind === 'outro') {
    if (window.IntroOutro) window.IntroOutro.draw(activeCtx, s.kind, OUTPUT_W, OUTPUT_H);
  }
  // 'black' → rien à dessiner
}

function renderFrame() {
  // ---------- Program ----------
  activeCtx = ctx;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);

  const elapsed = performance.now() - transitionStart;
  const transDur = transitionCfg.kind === 'cut' ? 0 : transitionCfg.durationMs;
  if (previousProgramScene && transDur > 0 && elapsed < transDur) {
    drawScene(previousProgramScene);
    ctx.globalAlpha = elapsed / transDur;
    drawScene(programScene);
    ctx.globalAlpha = 1;
  } else {
    if (previousProgramScene) previousProgramScene = null;
    drawScene(programScene);
  }

  // ---------- Preview (uniquement si studio mode actif) ----------
  if (studioMode) {
    activeCtx = previewCtx;
    previewCtx.fillStyle = '#000';
    previewCtx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
    drawScene(previewScene);
    activeCtx = ctx;
  }

  requestAnimationFrame(renderFrame);
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
function rebuildProgramStream() {
  const videoStream = programCanvas.captureStream(OUTPUT_FPS);
  const tracks = [videoStream.getVideoTracks()[0]];
  if (programAudioStream) {
    const at = programAudioStream.getAudioTracks()[0];
    if (at) tracks.push(at);
  }
  programStream = new MediaStream(tracks);

  // Si la fenêtre projecteur est ouverte, lui pousser le nouveau stream
  if (outputWindow && !outputWindow.closed && outputWindow.setProgramStream) {
    outputWindow.setProgramStream(programStream);
  }

  // Si la TV reçoit la vidéo, refaire l'appel avec le nouveau stream
  if (tvMediaCall && tvPeerId && signalingPeer && !signalingPeer.disconnected) {
    try { tvMediaCall.close(); } catch (e) {}
    tvMediaCall = signalingPeer.call(tvPeerId, programStream);
    if (tvMediaCall) {
      tvMediaCall.on('close', () => {
        if (tvMediaCall) {
          tvMediaCall = null;
          const tg = $('tvVideoToggle');
          if (tg) tg.checked = false;
        }
      });
    }
  }
}

// ============ Projecteur ============
function openProjector() {
  if (!programStream) rebuildProgramStream();
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
      toast('Fenêtre projecteur ouverte — glisse-la sur l\'écran du projecteur puis F11');
    } else {
      setTimeout(tryAttach, 100);
    }
  };
  tryAttach();
}

// ============ Enregistrement ============
function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (!programStream) rebuildProgramStream();

  recordedChunks = [];
  const mime = pickMime();
  try {
    mediaRecorder = new MediaRecorder(programStream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  } catch (e) {
    toast('MediaRecorder non supporté : ' + e.message, true);
    return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    a.href = url;
    a.download = `versetlive-${ts}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
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
}

function setStatus(s) { $('studioStatus').textContent = s; }

// ============ Synchro verset ============
function applyVerseState(state) {
  verseState = state;
  renderVerseStatus();
}

function renderVerseStatus() {
  const el = $('verseStatus');
  if (!verseState) {
    el.innerHTML = '<div class="studio-empty">Aucun verset affiché.<br><small>Diffuse depuis l\'onglet principal.</small></div>';
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

// Init depuis localStorage
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) applyVerseState(JSON.parse(saved));
} catch (e) {}

// BroadcastChannel
try {
  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'show') applyVerseState(msg.payload);
    else if (msg.type === 'showTitle') applyVerseState({ ...msg.payload, kind: 'title' });
    else if (msg.type === 'clear') applyVerseState({ style: verseState?.style });
    else if (msg.type === 'style') applyVerseState({ ...(verseState || {}), style: msg.payload });
    // Forward to TV (si connectée)
    sendToTv(msg);
  });
} catch (e) {}

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
const remoteCalls = new Map(); // peerId → { call, sourceId }

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
  // Éviter doublon si on reçoit un 2e stream du même peer
  if (remoteCalls.has(call.peer)) {
    const prev = remoteCalls.get(call.peer);
    const prevSrc = sources.find(s => s.id === prev.sourceId);
    if (prevSrc) {
      prevSrc.stream = stream;
      prevSrc.videoEl.srcObject = stream;
      return;
    }
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
    deviceId: 'remote-' + call.peer,
    label: `📱 Téléphone ${remoteCount}`,
    stream,
    videoEl,
    muted: false,
    peer: call.peer
  };
  sources.push(source);
  remoteCalls.set(call.peer, { call, sourceId: source.id });

  renderSources();
  renderScenes();
  toast(`Connecté : ${source.label}`);
}

function removeRemoteCall(call) {
  const entry = remoteCalls.get(call.peer);
  if (!entry) return;
  const src = sources.find(s => s.id === entry.sourceId);
  if (src) {
    // L'audio routé via Web Audio sera nettoyé par disconnectSourceAudio()
    disconnectSourceAudio(src);
    src.stream.getTracks().forEach(t => t.stop());
    const idx = sources.indexOf(src);
    sources.splice(idx, 1);
  }
  remoteCalls.delete(call.peer);
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
  if (!connected) {
    $('tvVideoToggle').checked = false;
  }
}

function setTvStatusText(text) {
  $('tvStatusText').textContent = text;
}

function sendToTv(msg) {
  if (!tvDataConn || !tvDataConn.open) return;
  try { tvDataConn.send(msg); } catch (e) {}
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
    $('tvVideoToggle').checked = false;
    return;
  }
  if (!programStream) rebuildProgramStream();
  if (!programStream || !programStream.getVideoTracks().length) {
    toast('Aucune source vidéo dans le programme. Ajoute une caméra d\'abord.', true);
    $('tvVideoToggle').checked = false;
    return;
  }
  if (tvMediaCall) {
    try { tvMediaCall.close(); } catch (e) {}
    tvMediaCall = null;
  }
  tvMediaCall = signalingPeer.call(tvPeerId, programStream);
  if (!tvMediaCall) {
    toast('Impossible de démarrer la vidéo vers la TV', true);
    $('tvVideoToggle').checked = false;
    return;
  }
  tvMediaCall.on('close', () => {
    if (tvMediaCall) {
      tvMediaCall = null;
      $('tvVideoToggle').checked = false;
    }
  });
  tvMediaCall.on('error', (err) => {
    console.warn('TV call error', err);
    toast('Erreur vidéo TV : ' + (err.type || err.message || 'inconnue'), true);
    tvMediaCall = null;
    $('tvVideoToggle').checked = false;
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

  $('tvVideoToggle').addEventListener('change', (e) => {
    if (e.target.checked) startTvVideo();
    else stopTvVideo(false);
  });
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

  // Préparer MediaRecorder sur le stream du programme
  const mime = pickStreamMime();
  if (!mime) {
    toast('Aucun codec compatible', true);
    return;
  }

  try {
    streamRecorder = new MediaRecorder(programStream, {
      mimeType: mime,
      videoBitsPerSecond: 4_500_000,
      audioBitsPerSecond: 128_000
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

// ============ Audio des téléphones (routing optionnel) ============
function connectSourceAudio(source) {
  if (!source || source.audioRouted) return;
  if (!source.stream.getAudioTracks().length) return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!audioDest) rebuildAudioGraph();
  try {
    if (source.audioGainValue == null) source.audioGainValue = 1.0;
    source.audioSrc = audioCtx.createMediaStreamSource(source.stream);
    source.audioGain = audioCtx.createGain();
    source.audioGain.gain.value = source.audioGainValue;
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
  const idx = imageSources.map(i => ({ id: i.id, name: i.name }));
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
      imageSources.push({ id: meta.id, name: meta.name, dataUrl, imgEl: img });
      const n = parseInt(meta.id.replace(/^im/, ''), 10);
      if (!isNaN(n) && n > maxId) maxId = n;
    } catch (e) { console.warn('Image load failed', meta, e); }
  }
  nextImageId = maxId + 1;
  loadLogoCfg();
  renderImages();
  renderLogoOverlayUi();
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
        <button class="btn btn-sm btn-danger studio-image-remove" data-id="${img.id}" title="Retirer">×</button>
      </div>
    `;
    card.querySelector('.studio-image-remove').addEventListener('click', () => {
      if (confirm(`Retirer l'image « ${img.name} » ?`)) removeImage(img.id);
    });
    list.appendChild(card);
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
      transitionCfg.kind = b.dataset.kind === 'cut' ? 'cut' : 'fade';
      saveTransitionCfg();
      applyTransitionUi();
    });
  });
  $('transitionDuration').addEventListener('input', (e) => {
    transitionCfg.durationMs = parseInt(e.target.value, 10);
    saveTransitionCfg();
    $('transitionDurationVal').textContent = transitionCfg.durationMs + ' ms';
  });
}

// ============ Boot ============
async function init() {
  bindUi();
  bindRemoteHelp();
  bindTvUi();
  bindStreaming();
  bindShortcuts();
  bindImagesUi();
  bindStudioModeUi();
  bindTransitionUi();
  applyStudioModeUi();
  applyTransitionUi();
  // Init module intro/outro (chargement assets IndexedDB + bind modal)
  if (window.IntroOutro) {
    window.IntroOutro.init({ onChange: () => renderScenes() });
  }
  renderScenes();
  renderVerseStatus();
  renderDestinations();
  startAudioMeter();
  startSourceVuLoop();
  requestAnimationFrame(renderFrame);
  rebuildProgramStream();
  await refreshDeviceList();
  loadStoredImages();
  initSignaling();
  connectRelay();
}
init();
