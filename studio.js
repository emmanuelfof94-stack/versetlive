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

// Scène active : { kind, primaryId?, secondaryId? }
//   kind ∈ { 'camera', 'camera+verse', 'pip', 'verse', 'black' }
let currentScene = { kind: 'black' };
let previousScene = null;
let transitionStart = 0;
const TRANSITION_MS = 300;

let verseState = null;

// ============ DOM ============
const $ = id => document.getElementById(id);
const programCanvas = $('programCanvas');
const ctx = programCanvas.getContext('2d', { alpha: false });

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
  if (currentScene.primaryId === sourceId || currentScene.secondaryId === sourceId) {
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
    const audioBtn = hasAudio
      ? `<button class="btn btn-sm studio-source-audio ${s.audioRouted ? 'on' : ''}" data-id="${s.id}" title="${s.audioRouted ? 'Couper l\'audio de cette source dans le mix' : 'Inclure l\'audio de cette source dans le mix'}">${s.audioRouted ? '🔊' : '🔇'}</button>`
      : '';
    const card = document.createElement('div');
    card.className = 'studio-source-card';
    card.innerHTML = `
      <div class="studio-source-preview"></div>
      <div class="studio-source-meta">
        <span class="studio-source-name">${i + 1}. ${escapeHtml(s.label)}</span>
        <div class="studio-source-actions">
          ${audioBtn}
          <button class="btn btn-sm btn-danger studio-source-remove" data-id="${s.id}" title="Retirer">×</button>
        </div>
      </div>
    `;
    // Aperçu live : un <video> dédié partageant le même MediaStream.
    // (Le s.videoEl maître reste détaché du DOM, utilisé uniquement par le canvas.)
    const previewDiv = card.querySelector('.studio-source-preview');
    const liveVideo = document.createElement('video');
    liveVideo.srcObject = s.stream;
    liveVideo.autoplay = true;
    liveVideo.muted = true;
    liveVideo.playsInline = true;
    previewDiv.appendChild(liveVideo);

    card.querySelector('.studio-source-remove').addEventListener('click', () => removeCamera(s.id));
    const ab = card.querySelector('.studio-source-audio');
    if (ab) ab.addEventListener('click', () => toggleSourceAudio(s.id));
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
  if (sources.length >= 2) {
    list.push({
      key: 'pip',
      label: `PiP (Cam 1 + Cam 2)`,
      scene: { kind: 'pip', primaryId: sources[0].id, secondaryId: sources[1].id }
    });
  }
  list.push({ key: 'verse', label: 'Verset plein écran', scene: { kind: 'verse' } });
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
  list.innerHTML = '';
  scenes.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'studio-scene-btn';
    btn.textContent = s.label;
    if (sceneKey(currentScene) === s.key) btn.classList.add('active');
    btn.addEventListener('click', () => setScene(s.scene));
    list.appendChild(btn);
  });
}

function sceneKey(scene) {
  if (scene.kind === 'camera') return `cam-${scene.primaryId}`;
  if (scene.kind === 'camera+verse') return `cam-verse-${scene.primaryId}`;
  if (scene.kind === 'pip') return 'pip';
  if (scene.kind === 'verse') return 'verse';
  return 'black';
}

// ============ Boucle de rendu programme ============
function drawVideoCover(video, x, y, w, h) {
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
  ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
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
    ctx.fillStyle = hexWithAlpha(bgColor, bgOpacity);
    if (bgType === 'overlay') {
      // bandeau centré
      const bw = w * 0.85;
      const bh = h * 0.6;
      ctx.fillRect(x + (w - bw) / 2, y + (h - bh) / 2, bw, bh);
    } else {
      ctx.fillRect(x, y, w, h);
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

  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';

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

    ctx.font = `${fontSizePx}px ${fontFamily}`;
    lines.forEach((line, i) => ctx.fillText(line, textX, startY + i * lineHeight));

    // Référence
    if (ref && (style.showRef || 'below') !== 'hide') {
      ctx.font = `italic ${refSizePx}px ${fontFamily}`;
      const refY = (style.showRef === 'above')
        ? startY - lineHeight
        : startY + lines.length * lineHeight + refSizePx * 0.3;
      ctx.fillText(ref, textX, refY);
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
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${mainSize}px ${fontFamily}`;
  ctx.fillText(main, mx, y + h / 2 - subSize);
  if (sub) {
    ctx.font = `${subSize}px ${fontFamily}`;
    ctx.fillStyle = state.accent || '#d4af37';
    ctx.fillText(sub, mx, y + h / 2 + mainSize * 0.6);
  }
}

function wrapText(text, maxWidth, fontSize, fontFamily) {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
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
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
  } else if (kind === 'strong') {
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 14;
    ctx.shadowOffsetX = 4; ctx.shadowOffsetY = 4;
  } else if (kind === 'outline') {
    ctx.shadowColor = 'rgba(0,0,0,1)'; ctx.shadowBlur = 6;
  } else if (kind === 'glow') {
    ctx.shadowColor = 'rgba(212,175,55,0.85)'; ctx.shadowBlur = 24;
  } else { // soft
    ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
  }
}
function resetShadow() {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function getSource(id) {
  return sources.find(s => s.id === id);
}

function setScene(scene) {
  if (sceneKey(currentScene) === sceneKey(scene)) return;
  previousScene = currentScene;
  currentScene = scene;
  transitionStart = performance.now();
  renderScenes();
}

function drawScene(s) {
  if (s.kind === 'camera' || s.kind === 'camera+verse') {
    const src = getSource(s.primaryId);
    if (src) drawVideoCover(src.videoEl, 0, 0, OUTPUT_W, OUTPUT_H);
    if (s.kind === 'camera+verse') {
      // Verset en bas, sur le tiers inférieur, fond translucide
      const h = OUTPUT_H * 0.30;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, OUTPUT_H - h, OUTPUT_W, h);
      drawVerseOverlay({ x: 0, y: OUTPUT_H - h, w: OUTPUT_W, h });
    }
  } else if (s.kind === 'pip') {
    const main = getSource(s.primaryId);
    const corner = getSource(s.secondaryId);
    if (main) drawVideoCover(main.videoEl, 0, 0, OUTPUT_W, OUTPUT_H);
    if (corner) {
      const pipW = OUTPUT_W * 0.28;
      const pipH = pipW * 9 / 16;
      const pipX = OUTPUT_W - pipW - 40;
      const pipY = 40;
      ctx.fillStyle = '#fff';
      ctx.fillRect(pipX - 4, pipY - 4, pipW + 8, pipH + 8);
      drawVideoCover(corner.videoEl, pipX, pipY, pipW, pipH);
    }
  } else if (s.kind === 'verse') {
    drawVerseOverlay({ x: 0, y: 0, w: OUTPUT_W, h: OUTPUT_H });
  }
  // 'black' → rien à dessiner
}

function renderFrame() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);

  const elapsed = performance.now() - transitionStart;
  if (previousScene && elapsed < TRANSITION_MS) {
    // Crossfade : ancienne scène pleine + nouvelle qui apparaît en fondu
    drawScene(previousScene);
    ctx.globalAlpha = elapsed / TRANSITION_MS;
    drawScene(currentScene);
    ctx.globalAlpha = 1;
  } else {
    if (previousScene) previousScene = null;
    drawScene(currentScene);
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
  });
} catch (e) {}

// Storage fallback (autre onglet)
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  try { applyVerseState(JSON.parse(e.newValue)); } catch (err) {}
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
  if (src && (currentScene.primaryId === src.id || currentScene.secondaryId === src.id)) {
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
    source.audioSrc = audioCtx.createMediaStreamSource(source.stream);
    source.audioGain = audioCtx.createGain();
    source.audioGain.gain.value = 1;
    source.audioSrc.connect(source.audioGain);
    source.audioGain.connect(audioDest);
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
  source.audioGain = null;
  source.audioSrc = null;
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

// ============ Boot ============
async function init() {
  bindUi();
  bindRemoteHelp();
  bindStreaming();
  bindShortcuts();
  renderScenes();
  renderVerseStatus();
  renderDestinations();
  startAudioMeter();
  requestAnimationFrame(renderFrame);
  rebuildProgramStream();
  await refreshDeviceList();
  initSignaling();
  connectRelay();
}
init();
