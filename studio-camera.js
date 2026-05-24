// Page téléphone : capture caméra + micro et envoie en WebRTC P2P au Studio.
// Signaling via PeerJS Cloud (broker public).
//
// Pipeline vidéo : caméra → <video id="srcVideo"> caché → canvas (avec zoom appliqué)
// → canvas.captureStream() → MediaStreamTrack envoyé via peer.call().
// Le canvas tourne à 30 fps via requestAnimationFrame et applique le zoom + miroir.
// L'audio reste sur la track audio brute de la caméra (pas de re-encodage).

const PEER_PREFIX = 'versetlive-studio-';

const $ = id => document.getElementById(id);
const setup = $('setupScreen');
const live = $('liveScreen');
const roomInput = $('roomInput');
const facingSelect = $('facingSelect');
const connectBtn = $('connectBtn');
const setupError = $('setupError');
const previewCanvas = $('preview');
const srcVideo = $('srcVideo');
const liveDot = $('liveDot');
const liveStatusText = $('liveStatusText');
const liveRoomTag = $('liveRoomTag');
const switchBtn = $('switchBtn');
const muteBtn = $('muteBtn');
const muteLabel = $('muteLabel');
const stopBtn = $('stopBtn');
const zoomBadge = $('zoomBadge');
const zoomCol = $('zoomCol');
const zoomInBtn = $('zoomInBtn');
const zoomOutBtn = $('zoomOutBtn');
const zoomSlider = $('zoomSlider');

const ctx = previewCanvas.getContext('2d', { alpha: false });

const ZOOM_MIN = 1.0;
const ZOOM_MAX = 5.0;
const ZOOM_STEP = 0.1;

let cameraStream = null;      // flux brut getUserMedia (vidéo + audio)
let outgoingStream = null;    // ce qu'on envoie : canvas video + camera audio
let peer = null;
let call = null;
let roomCode = '';
let facing = 'environment';
let audioMuted = false;
let zoom = 1.0;               // 1.0 → 5.0
let renderRaf = 0;
let zoomBadgeTimer = 0;

// Pré-remplir le code via ?room=
const params = new URLSearchParams(location.search);
const roomFromUrl = params.get('room');
if (roomFromUrl) {
  roomInput.value = roomFromUrl.toUpperCase();
  setTimeout(() => connectBtn.focus(), 100);
}

// Vérifier HTTPS (sauf localhost)
if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  showError('Cette page doit être ouverte en HTTPS pour accéder à la caméra. Va sur la version Vercel.');
}

connectBtn.addEventListener('click', startSession);
roomInput.addEventListener('input', () => {
  roomInput.value = roomInput.value.toUpperCase();
});

switchBtn.addEventListener('click', switchCamera);
muteBtn.addEventListener('click', toggleMute);
stopBtn.addEventListener('click', stopSession);

// ===== Zoom : pinch + boutons + slider =====
function clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }
function setZoom(z, source) {
  zoom = clampZoom(z);
  // Sync UI
  zoomSlider.value = String(Math.round(zoom * 100));
  zoomBadge.textContent = `${zoom.toFixed(1)}× zoom`;
  showZoomBadge();
  zoomInBtn.disabled = zoom >= ZOOM_MAX - 1e-3;
  zoomOutBtn.disabled = zoom <= ZOOM_MIN + 1e-3;
}
function showZoomBadge() {
  zoomBadge.classList.add('show');
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = setTimeout(() => zoomBadge.classList.remove('show'), 1500);
}

zoomInBtn.addEventListener('click', () => setZoom(zoom + 0.25));
zoomOutBtn.addEventListener('click', () => setZoom(zoom - 0.25));
zoomSlider.addEventListener('input', (e) => setZoom(parseInt(e.target.value, 10) / 100));

// Pinch zoom à 2 doigts sur le canvas
let pinchStartDist = 0;
let pinchStartZoom = 1;
function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}
previewCanvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinchStartDist = touchDist(e.touches);
    pinchStartZoom = zoom;
    e.preventDefault();
  }
}, { passive: false });
previewCanvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStartDist > 0) {
    const ratio = touchDist(e.touches) / pinchStartDist;
    setZoom(pinchStartZoom * ratio);
    e.preventDefault();
  }
}, { passive: false });
previewCanvas.addEventListener('touchend', () => {
  pinchStartDist = 0;
});
// Souris (test desktop) : molette = zoom
previewCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
}, { passive: false });

// ===== Boucle de rendu canvas =====
// Dessine le srcVideo en cover dans le canvas en appliquant zoom + mirror.
function renderFrame() {
  if (srcVideo.videoWidth && srcVideo.videoHeight) {
    const vw = srcVideo.videoWidth, vh = srcVideo.videoHeight;
    const cw = previewCanvas.width, ch = previewCanvas.height;
    const sAR = vw / vh, dAR = cw / ch;
    let sx, sy, sw, sh;
    if (sAR > dAR) {
      sh = vh; sw = sh * dAR;
      sx = (vw - sw) / 2; sy = 0;
    } else {
      sw = vw; sh = sw / dAR;
      sx = 0; sy = (vh - sh) / 2;
    }
    // Punch-in numérique centré
    const z = clampZoom(zoom);
    if (z > 1) {
      const newSw = sw / z, newSh = sh / z;
      sx = sx + (sw - newSw) / 2;
      sy = sy + (sh - newSh) / 2;
      sw = newSw; sh = newSh;
    }
    // On dessine en orientation naturelle (sans mirror) — le studio reçoit la
    // vidéo "normale". Le mirror selfie est purement cosmétique côté preview
    // et appliqué en CSS sur le canvas (transform: scaleX(-1)).
    ctx.drawImage(srcVideo, sx, sy, sw, sh, 0, 0, cw, ch);
  }
  renderRaf = requestAnimationFrame(renderFrame);
}

// Empêcher la mise en veille (Wake Lock API)
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* pas de wake lock = pas grave */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cameraStream && !wakeLock) requestWakeLock();
});

function showError(msg) {
  setupError.textContent = msg;
  setupError.hidden = false;
}
function hideError() { setupError.hidden = true; }

function setLiveStatus(text, kind) {
  liveStatusText.textContent = text;
  liveDot.classList.remove('live', 'err');
  if (kind) liveDot.classList.add(kind);
}

async function startSession() {
  hideError();
  const code = roomInput.value.trim().toUpperCase();
  if (!code) return showError('Saisis le code de salle (visible dans le Studio).');
  roomCode = code.startsWith('VL-') ? code : 'VL-' + code;
  facing = facingSelect.value;

  connectBtn.disabled = true;
  connectBtn.textContent = 'Activation caméra…';

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
  } catch (e) {
    connectBtn.disabled = false;
    connectBtn.textContent = '▶ Se connecter';
    return showError('Caméra/micro refusés : ' + e.message);
  }

  // Brancher la vidéo source sur le <video> caché. Ce sont ses frames que le
  // canvas pompera dans la boucle de rendu.
  srcVideo.srcObject = cameraStream;
  await srcVideo.play().catch(() => {});

  // Adapter la résolution canvas au format réel de la caméra (typiquement 1280×720
  // mais peut varier — surtout selfie qui peut être en portrait).
  const vt = cameraStream.getVideoTracks()[0];
  if (vt) {
    const s = vt.getSettings();
    if (s.width && s.height) {
      previewCanvas.width = s.width;
      previewCanvas.height = s.height;
    }
  }

  // Démarrer la boucle de rendu canvas
  cancelAnimationFrame(renderRaf);
  renderRaf = requestAnimationFrame(renderFrame);

  // Construire le flux sortant : vidéo issue du canvas + audio brut de la caméra
  const canvasStream = previewCanvas.captureStream(30);
  outgoingStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...cameraStream.getAudioTracks(),
  ]);

  setup.style.display = 'none';
  live.classList.add('show');
  previewCanvas.classList.toggle('mirror', facing === 'user');
  liveRoomTag.textContent = roomCode;
  setLiveStatus('Connexion…');
  setZoom(1.0); // initialise UI zoom
  requestWakeLock();

  await connectToStudio();
}

async function connectToStudio() {
  peer = new Peer({ debug: 1 });

  peer.on('open', () => {
    const targetId = PEER_PREFIX + roomCode;
    setLiveStatus('Appel du Studio…');
    call = peer.call(targetId, outgoingStream);
    if (!call) {
      setLiveStatus('Studio injoignable', 'err');
      return;
    }

    call.on('close', () => {
      setLiveStatus('Studio déconnecté', 'err');
    });
    call.on('error', (err) => {
      console.warn('call error', err);
      setLiveStatus('Erreur connexion', 'err');
    });

    if (call.peerConnection) {
      call.peerConnection.addEventListener('connectionstatechange', () => {
        const s = call.peerConnection.connectionState;
        if (s === 'connected') setLiveStatus('● En direct', 'live');
        else if (s === 'disconnected' || s === 'failed') setLiveStatus('Connexion perdue', 'err');
        else if (s === 'closed') setLiveStatus('Fermé', 'err');
      });
    }
  });

  peer.on('error', (err) => {
    console.warn('peer error', err.type, err);
    if (err.type === 'peer-unavailable') {
      setLiveStatus('Studio introuvable — vérifie le code', 'err');
    } else if (err.type === 'network' || err.type === 'disconnected') {
      setLiveStatus('Réseau coupé', 'err');
    } else {
      setLiveStatus('Erreur : ' + err.type, 'err');
    }
  });

  peer.on('disconnected', () => {
    setLiveStatus('Déconnecté — reconnexion…', 'err');
    setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000);
  });
}

async function switchCamera() {
  facing = facing === 'environment' ? 'user' : 'environment';
  try {
    // Stopper l'ancienne vidéo (l'audio reste — on ne re-demande pas le micro)
    cameraStream.getVideoTracks().forEach(t => t.stop());
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    // Reconstruire cameraStream avec le nouveau track vidéo + l'audio existant
    const audio = cameraStream.getAudioTracks();
    const oldVideos = cameraStream.getVideoTracks();
    oldVideos.forEach(t => cameraStream.removeTrack(t));
    cameraStream.addTrack(newVideoTrack);
    srcVideo.srcObject = cameraStream;
    await srcVideo.play().catch(() => {});
    previewCanvas.classList.toggle('mirror', facing === 'user');
    // Le canvas continue à pomper les frames de srcVideo : aucun replaceTrack
    // sur la RTCPeerConnection nécessaire (le track sortant reste celui du canvas).
    setZoom(1.0); // reset zoom après bascule caméra
  } catch (e) {
    showLiveToast('Bascule caméra impossible : ' + e.message);
  }
}

function toggleMute() {
  audioMuted = !audioMuted;
  cameraStream.getAudioTracks().forEach(t => t.enabled = !audioMuted);
  muteLabel.textContent = audioMuted ? 'Coupé' : 'Micro';
  muteBtn.style.opacity = audioMuted ? '0.5' : '1';
}

function stopSession() {
  if (!confirm('Arrêter la diffusion ?')) return;
  cleanup();
  location.reload();
}

function cleanup() {
  try { if (call) call.close(); } catch (e) {}
  try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) {}
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
  if (outgoingStream) outgoingStream.getTracks().forEach(t => t.stop());
  if (renderRaf) cancelAnimationFrame(renderRaf);
  if (wakeLock) try { wakeLock.release(); } catch (e) {}
  cameraStream = null; outgoingStream = null; peer = null; call = null;
}

window.addEventListener('beforeunload', cleanup);

function showLiveToast(msg) {
  const prev = liveStatusText.textContent;
  setLiveStatus(msg);
  setTimeout(() => setLiveStatus(prev, 'live'), 3000);
}
