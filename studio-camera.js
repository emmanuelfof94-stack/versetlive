// Page téléphone : capture caméra + micro et envoie en WebRTC P2P au Studio.
// Signaling via PeerJS Cloud (broker public).
//
// Pipeline vidéo : caméra → <video id="srcVideo"> caché → canvas (avec zoom appliqué)
// → canvas.captureStream() → MediaStreamTrack envoyé via peer.call().
// Le canvas tourne à 30 fps via requestAnimationFrame et applique le zoom + miroir.
// L'audio reste sur la track audio brute de la caméra (pas de re-encodage).
//
// RACCOURCI FAIBLE LATENCE : le canvas ne sert QU'À recadrer en 16:9 et zoomer.
// Quand la caméra sort déjà du 16:9 et que le zoom est à 1×, il ne fait qu'une
// copie pixel pour pixel — on envoie alors la piste caméra telle quelle. Voir
// shouldSendRaw() / syncVideoSendMode().

const PEER_PREFIX = 'versetlive-studio-';

// Identifiant d'appareil STABLE (persisté). L'ID PeerJS change à chaque
// chargement de la page ; ce deviceId, lui, reste le même → permet au Studio
// de reconnaître ce téléphone après une actualisation et de réutiliser la même
// caméra (au lieu d'en ouvrir une seconde et de laisser l'ancienne figée).
const DEVICE_ID_KEY = 'versetlive:cam-device-id';
function getCamDeviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_ID_KEY); } catch (e) {}
  if (!id) {
    id = 'cam-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {}
  }
  return id;
}

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
const rotateLeftBtn = $('rotateLeftBtn');
const rotateRightBtn = $('rotateRightBtn');
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
rotateLeftBtn.addEventListener('click', rotatePreviewLeft);
rotateRightBtn.addEventListener('click', rotatePreviewRight);
muteBtn.addEventListener('click', toggleMute);
stopBtn.addEventListener('click', stopSession);

// ===== Rotation de l'aperçu (locale au téléphone, n'affecte pas le flux envoyé) =====
// Le cadre 16:9 diffusé au Studio reste identique ; on ne fait que pivoter
// l'affichage local pour qu'il remplisse bien l'écran selon comment l'opérateur
// tient son téléphone. 0/180 → le canvas remplit l'écran ; 90/270 → dimensions
// croisées (vh/vw) pour remplir une fois pivoté (géré en CSS via data-rot).
let previewRotation = 0; // 0, 90, 180, 270
function applyPreviewTransform() {
  previewCanvas.dataset.rot = String(previewRotation);
  let t = 'translate(-50%, -50%)';
  if (previewRotation) t += ` rotate(${previewRotation}deg)`;
  if (facing === 'user') t += ' scaleX(-1)'; // miroir selfie (cosmétique)
  previewCanvas.style.transform = t;
}
function rotatePreviewRight() {
  previewRotation = (previewRotation + 90) % 360;
  applyPreviewTransform();
}
function rotatePreviewLeft() {
  previewRotation = (previewRotation + 270) % 360;
  applyPreviewTransform();
}

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
  // Zoom ≠ 1× → il faut repasser par le canvas (c'est lui qui recadre) ;
  // retour à 1× → on redonne la piste caméra directe.
  syncVideoSendMode('zoom ' + zoom.toFixed(2));
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

// Attend que le <video> ait une vraie frame décodée (dimensions > 0). Repli sur
// un timeout pour ne jamais bloquer le démarrage si l'événement n'arrive pas.
function waitForVideoFrame(video, timeoutMs = 3000) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const tick = () => {
      if (done) return;
      if (video.videoWidth && video.videoHeight) return finish();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(finish, timeoutMs);
  });
}

// ===== Boucle de rendu canvas =====
// Dessine le srcVideo en cover dans le canvas en appliquant zoom + mirror.
//
// ⚠️ Ce canvas EST le flux envoyé au Studio (captureStream). S'il cesse d'être
// peint, la piste vidéo n'émet plus AUCUNE image : le Studio reste « connecté »,
// l'audio continue de passer, mais la tuile devient noire. Or les navigateurs
// gèlent requestAnimationFrame dès que la page n'est plus visible au premier plan
// (écran éteint, changement d'appli, onglet en fond). D'où la boucle de secours
// ci-dessous, portée par un Web Worker — même motif que le Studio.
const RENDER_INTERVAL_MS = 33; // ~30 fps, la cadence de captureStream

// Dessin calé sur une grille de temps : plusieurs sources (rAF + timer + worker)
// peuvent tiquer sans provoquer de double dessin inutile.
let lastDrawTs = 0;
function renderTick() {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - lastDrawTs < RENDER_INTERVAL_MS - 4) return;
  lastDrawTs = now;
  drawPreviewFrame();
}

// Le rAF suivant est TOUJOURS replanifié, même si le dessin lève une exception :
// sinon une seule frame fautive tuerait la boucle → flux figé jusqu'au rechargement.
function renderFrame() {
  try { renderTick(); } catch (e) { console.error('[Cam] frame ignorée', e); }
  renderRaf = requestAnimationFrame(renderFrame);
}

// Boucle de secours : maintient le canvas vivant (donc le flux vidéo) quand rAF
// est gelé. Le check document.hidden laisse rAF gérer le premier plan.
let bgRenderTimer = null;
let bgRenderWorker = null;
function startBgRenderLoop() {
  if (bgRenderTimer) return;
  // 1) Timer classique : utile, mais le thread principal peut être throttlé à
  //    ~1 Hz (voire 1/min) quand la page passe en arrière-plan.
  bgRenderTimer = setInterval(() => {
    if (document.hidden) renderTick();
  }, RENDER_INTERVAL_MS);
  // 2) Tick porté par un Web Worker : ses timers échappent au throttling agressif
  //    des pages en arrière-plan → réveille le dessin à ~30 fps même écran éteint.
  try {
    const src = 'var h=null;onmessage=function(e){var ms=(e.data&&e.data.ms)||33;if(h)clearInterval(h);h=setInterval(function(){postMessage(1);},ms);};';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    bgRenderWorker = new Worker(url);
    bgRenderWorker.onmessage = () => { if (document.hidden) renderTick(); };
    bgRenderWorker.postMessage({ ms: RENDER_INTERVAL_MS });
  } catch (e) { /* worker indispo : le setInterval assure le repli */ }
}

// Son inaudible en boucle : une page qui joue de l'audio est exemptée du
// throttling le plus agressif des timers → la boucle de secours garde sa cadence.
let keepAliveCtx = null;
function startAudioKeepAlive() {
  if (keepAliveCtx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    keepAliveCtx = new AC();
    const osc = keepAliveCtx.createOscillator();
    const gain = keepAliveCtx.createGain();
    gain.gain.value = 0.0001; // inaudible, mais l'onglet est considéré « sonore »
    osc.connect(gain).connect(keepAliveCtx.destination);
    osc.start();
    if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
  } catch (e) { /* pas de keepAlive = le worker fait déjà l'essentiel */ }
}

// Un seul dessin du canvas (sans reprogrammer la boucle). Utilisé aussi pour
// « amorcer » le canvas avec une vraie frame AVANT captureStream : capturer un
// canvas encore vierge produit parfois (Chrome Android) une piste vidéo « née
// noire » → le Studio reçoit alors une tuile noire bien que connecté.
function drawPreviewFrame() {
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
  } else {
    // Pas encore de frame caméra : remplir en noir pour que le canvas ait
    // quand même un contenu valide (évite un canvas transparent/non peint).
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  }
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

  // Attendre une vraie frame caméra (dimensions connues) avant de dimensionner
  // le canvas et de capturer. Capturer un canvas encore vierge crée parfois une
  // piste vidéo « née noire » → tuile noire côté Studio.
  await waitForVideoFrame(srcVideo);

  // Canvas en 16:9 (le format du Studio). On FORCE le ratio de sortie pour que
  // ce que l'opérateur cadre à l'écran corresponde EXACTEMENT à ce qui part à
  // l'antenne : la caméra est recadrée (cover) dans ce 16:9 par la boucle de
  // rendu, et l'aperçu (object-fit: contain) montre ce même 16:9. Sinon le
  // Studio recadrait lui-même → cadre différent de celui vu sur le téléphone.
  const vt = cameraStream.getVideoTracks()[0];
  let baseLong = 1280;
  if (vt) {
    const s = vt.getSettings();
    if (s.width && s.height) baseLong = Math.max(s.width, s.height);
  }
  previewCanvas.width = baseLong;
  previewCanvas.height = Math.round(baseLong * 9 / 16);

  // Amorcer le canvas avec une première frame AVANT captureStream (sinon piste
  // « née noire » sur certains Chrome Android), puis lancer la boucle.
  drawPreviewFrame();
  cancelAnimationFrame(renderRaf);
  renderRaf = requestAnimationFrame(renderFrame);
  // Boucles de survie : sans elles, le flux vidéo meurt dès que la page n'est
  // plus au premier plan (tuile noire côté Studio, audio toujours audible).
  startBgRenderLoop();
  startAudioKeepAlive();

  // Construire le flux sortant : vidéo (canvas OU caméra brute) + audio de la caméra.
  //
  // Le chemin le plus court est le moins lent. Passer par le canvas impose DEUX
  // ré-échantillonnages non synchronisés — caméra → canvas (grille 30 fps), puis
  // canvas → captureStream(30) — qui ajoutent chacun jusqu'à une image de retard
  // et, surtout, dupliquent ou sautent des images quand les cadences battent
  // (la saccade régulière visible sur un plan qui bouge). Quand le canvas ne fait
  // qu'une copie (caméra déjà 16:9 + zoom 1×), on saute les deux : la piste caméra
  // part telle quelle, avec ses horodatages d'origine. Bonus : le téléphone ne
  // dessine plus rien pour l'antenne, donc il chauffe moins et se throttle moins.
  canvasVideoTrack = previewCanvas.captureStream(30).getVideoTracks()[0] || null;
  rawVideoTrack = cameraStream.getVideoTracks()[0] || null;
  cropIsIdentity = isCropIdentity();
  if (!canvasVideoTrack) {
    // Certains navigateurs (vieilles WebView, Safari iOS ancien) ne savent pas
    // capturer un canvas. Avant, on affichait une erreur PUIS on envoyait quand
    // même un flux sans piste vidéo → tuile noire garantie côté Studio.
    console.warn('[Cam] canvas.captureStream muet → caméra brute imposée');
    rawForced = true;
    showLiveToast('Recadrage indisponible ici : envoi de la caméra brute');
  }
  usingRawTrack = shouldSendRaw();
  const outTrack = usingRawTrack ? rawVideoTrack : canvasVideoTrack;
  tuneOutgoingTrack(outTrack);
  console.log('[Cam] piste envoyée au démarrage :', usingRawTrack ? 'caméra brute (directe)' : 'canvas (recadrage/zoom)');
  outgoingStream = new MediaStream([
    ...(outTrack ? [outTrack] : []),
    ...cameraStream.getAudioTracks(),
  ]);

  setup.style.display = 'none';
  live.classList.add('show');
  // Rotation initiale selon l'orientation : en portrait, on pivote pour remplir
  // l'écran d'emblée ; l'opérateur peut ensuite ajuster avec le bouton « Pivoter ».
  previewRotation = (window.matchMedia && window.matchMedia('(orientation: portrait)').matches) ? 90 : 0;
  applyPreviewTransform();
  liveRoomTag.textContent = roomCode;
  setLiveStatus('Connexion…');
  setZoom(1.0); // initialise UI zoom
  requestWakeLock();

  await connectToStudio();
}

// Config ICE (TURN) : sans relais TURN, un téléphone qui ne peut pas joindre
// DIRECTEMENT le Studio se connecte quand même au signaling (qui passe par le
// cloud PeerJS) mais son flux vidéo ne passe pas → tuile NOIRE côté Studio.
// Ça arrive sur un autre réseau (4G, wifi invité) MAIS AUSSI sur le même wifi si
// le routeur isole les clients entre eux (« isolation AP / client isolation »,
// activée par défaut sur beaucoup de wifi publics et d'églises).
//
// Sources de relais, dans l'ordre :
//   1. /api/turn      → Cloudflare TURN (variables d'env Vercel)
//   2. TURN manuel    → identifiants en localStorage (dépannage sans redéploiement)
//   3. STUN seul      → pas de relais du tout
//
// L'ancien repli « Open Relay » (openrelay.metered.ca) a été retiré : le service
// gratuit a fermé, ses serveurs ne répondent plus (vérifié : timeout sur 80/443).
const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const TURN_LS_KEY = 'versetlive:turn-manuel';
function readManualTurn() {
  let raw = null;
  try { raw = localStorage.getItem(TURN_LS_KEY); } catch (e) {}
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const ok = list.filter(s => s && s.urls);
    return ok.length ? ok : null;
  } catch (e) { return null; }
}

// Renseigné par loadIceConfig ; sert au diagnostic affiché à l'opérateur.
let iceSource = null; // 'cloudflare' | 'manuel' | 'aucun'

let _iceConfigPromise = null;
function loadIceConfig() {
  if (_iceConfigPromise) return _iceConfigPromise;
  _iceConfigPromise = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch('/api/turn', { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const ice = data && data.iceServers;
      const servers = [];
      if (Array.isArray(ice)) servers.push(...ice);
      else if (ice) servers.push(ice);
      if (!servers.length) throw new Error('aucun serveur ICE renvoyé');
      servers.push({ urls: 'stun:stun.l.google.com:19302' });
      iceSource = 'cloudflare';
      return { iceServers: servers };
    } catch (e) {
      const why = (e && e.message) || String(e);
      const manual = readManualTurn();
      if (manual) {
        console.warn('[Cam] /api/turn indisponible (' + why + ') → TURN manuel (localStorage)');
        iceSource = 'manuel';
        return { iceServers: manual.concat(STUN_ONLY) };
      }
      console.warn('[Cam] AUCUN relais TURN (' + why + ') → le flux ne passera que si le Studio est joignable directement');
      iceSource = 'aucun';
      return { iceServers: STUN_ONLY };
    }
  })();
  return _iceConfigPromise;
}

async function connectToStudio() {
  const iceConfig = await loadIceConfig();
  const peerOpts = { debug: 1 };
  if (iceConfig) peerOpts.config = iceConfig;
  peer = new Peer(peerOpts);

  peer.on('open', () => {
    const targetId = PEER_PREFIX + roomCode;
    setLiveStatus('Appel du Studio…');
    // metadata.deviceId : clé stable pour que le Studio réutilise la même caméra
    // après une actualisation (sinon doublon + ancienne figée).
    call = peer.call(targetId, outgoingStream, { metadata: { deviceId: getCamDeviceId() } });
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
      tuneSenderForMotion(call.peerConnection);
      call.peerConnection.addEventListener('connectionstatechange', () => {
        const s = call.peerConnection.connectionState;
        if (s === 'connected') { setLiveStatus('● En direct', 'live'); tuneSenderForMotion(call.peerConnection); }
        else if (s === 'disconnected' || s === 'failed') setLiveStatus('Connexion perdue', 'err');
        else if (s === 'closed') setLiveStatus('Fermé', 'err');
      });
    }

    // Vérifier que la vidéo PART vraiment : « En direct » ne prouve que la
    // signalisation. Si 0 octet ne sort après 7 s, le Studio affichera une tuile
    // noire → autant le dire ici, sur le téléphone de l'opérateur.
    probeOutgoingStats(call);
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

// ===== Quelle piste vidéo part à l'antenne : caméra directe ou canvas ? =====
let canvasVideoTrack = null;  // piste du canvas (recadrage 16:9 + zoom numérique)
let rawVideoTrack = null;     // piste caméra telle quelle
let usingRawTrack = false;    // ce qui est réellement envoyé en ce moment
let rawForced = false;        // repli d'urgence : ne JAMAIS revenir au canvas
let cropIsIdentity = false;   // la caméra est déjà en 16:9 → le canvas ne recadre rien

// Le canvas est en 16:9. Si la caméra l'est aussi, son recadrage « cover » ne
// retire pas un seul pixel : ce que l'opérateur voit sur le téléphone est
// exactement ce que le Studio recevrait. On peut donc court-circuiter le canvas
// sans changer le cadrage. 1,5 % de tolérance : 1280×720, 1920×1080, 1024×576…
const AR_16_9 = 16 / 9;
function isCropIdentity() {
  const t = rawVideoTrack;
  if (!t || typeof t.getSettings !== 'function') return false;
  const st = t.getSettings();
  if (!st.width || !st.height) return false;
  return Math.abs((st.width / st.height) / AR_16_9 - 1) < 0.015;
}

function shouldSendRaw() {
  if (!rawVideoTrack || rawVideoTrack.readyState !== 'live') return false;
  if (rawForced) return true;        // canvas hors service
  if (!canvasVideoTrack) return true;
  return cropIsIdentity && zoom <= 1.001;
}

// Dit à l'encodeur que c'est de la vidéo de MOUVEMENT : quand le réseau se serre,
// il baisse la définition et garde les 30 img/s, au lieu de garder une belle
// image qui saccade. C'est le bon compromis pour un direct filmé.
function tuneOutgoingTrack(track) {
  if (!track) return;
  try { track.contentHint = 'motion'; } catch (e) {}
}
async function tuneSenderForMotion(pc) {
  if (!pc || typeof pc.getSenders !== 'function') return;
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender || typeof sender.getParameters !== 'function') return;
    const params = sender.getParameters();
    params.degradationPreference = 'maintain-framerate';
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxFramerate = 30;
    await sender.setParameters(params);
    console.log('[Cam] encodeur réglé : priorité à la fluidité (30 img/s)');
  } catch (e) { console.warn('[Cam] réglage encodeur ignoré', e); }
}

// Bascule la piste envoyée SANS couper la connexion (replaceTrack) : pas de
// renégociation, pas de coupure d'image côté Studio.
let sendModeSwitching = false;
async function syncVideoSendMode(why) {
  const wantRaw = shouldSendRaw();
  if (sendModeSwitching || wantRaw === usingRawTrack) return;
  const pc = call && call.peerConnection;
  const next = wantRaw ? rawVideoTrack : canvasVideoTrack;
  if (!pc || typeof pc.getSenders !== 'function') return;
  if (!next || next.readyState !== 'live') return;
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (!sender || typeof sender.replaceTrack !== 'function') return;
  sendModeSwitching = true;
  try {
    tuneOutgoingTrack(next);
    await sender.replaceTrack(next);
    usingRawTrack = wantRaw;
    console.log('[Cam] piste envoyée →', wantRaw ? 'caméra brute (directe)' : 'canvas (recadrage/zoom)', '·', why);
  } catch (e) {
    console.warn('[Cam] bascule de piste impossible', e);
  } finally {
    sendModeSwitching = false;
  }
}

// Repli d'urgence : forcer la piste caméra BRUTE quand le canvas n'émet plus
// rien (captureStream muet, page gelée par le système, piste « née noire »).
// On perd le recadrage et le zoom, mais l'image repart — c'est ce qui compte en
// plein direct. Une seule tentative (rawForced ne redescend jamais).
async function fallbackToRawCameraTrack(activeCall, why) {
  if (rawForced) return false;
  if (!rawVideoTrack || rawVideoTrack.readyState !== 'live') return false;
  rawForced = true; // avant l'await : pas de double tentative si la sonde re-tique
  if (usingRawTrack) return false; // déjà en direct : le canvas n'était pas en cause
  await syncVideoSendMode('repli — ' + why);
  if (usingRawTrack) showLiveToast('↻ Repli caméra brute (image sans recadrage)');
  return usingRawTrack;
}

// Sonde les statistiques d'envoi : dit si la vidéo sort réellement du téléphone
// et par quelle route (réseau local / direct / relais TURN). Résultat affiché
// dans la barre de statut + console (préfixe [Cam]).
async function probeOutgoingStats(activeCall) {
  const pc = activeCall && activeCall.peerConnection;
  if (!pc || typeof pc.getStats !== 'function') return;

  const sample = async () => {
    const stats = await pc.getStats();
    let outbound = null, pair = null;
    stats.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) outbound = r;
      if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
    });
    let route = null;
    if (pair) {
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const lt = local && local.candidateType, rt = remote && remote.candidateType;
      if (lt === 'relay' || rt === 'relay') route = 'relais';
      else if (lt === 'host' && rt === 'host') route = 'réseau local';
      else route = 'direct';
    }
    return {
      route,
      bytes: (outbound && outbound.bytesSent) || 0,
      frames: (outbound && outbound.framesSent) || 0,
      iceState: pc.iceConnectionState,
    };
  };

  const PERIOD_S = 7;
  let prev = await sample().catch(() => null);

  // Surveillance continue : si l'envoi meurt en cours de culte, l'opérateur du
  // téléphone doit le voir sur son écran, pas seulement le régisseur au Studio.
  const timer = setInterval(async () => {
    if (!call || call !== activeCall || pc.connectionState === 'closed') {
      clearInterval(timer);
      return;
    }
    const cur = await sample().catch(() => null);
    if (!cur) return;
    const dBytes = cur.bytes - ((prev && prev.bytes) || 0);
    const dFrames = cur.frames - ((prev && prev.frames) || 0);
    prev = cur;

    console.log('[Cam] envoi — diagnostic', {
      route: cur.route, iceState: cur.iceState, relais: iceSource,
      octetsSurPeriode: dBytes, framesSurPeriode: dFrames,
      pisteEnvoyee: usingRawTrack ? 'caméra brute' : 'canvas',
    });

    if (!cur.route) {
      // Aucune route ICE : le média ne peut physiquement pas passer. Si en plus
      // aucun relais TURN n'est configuré, c'est LA cause — le dire précisément.
      setLiveStatus(iceSource === 'aucun'
        ? '⚠️ Pas de route réseau — aucun relais TURN configuré'
        : '⚠️ Pas de route réseau vers le Studio', 'err');
    } else if (dFrames <= 0) {
      // Route établie mais aucune image ne part. Si on passait par le canvas,
      // c'est lui le suspect → repli sur la caméra brute. Si on envoyait DÉJÀ la
      // caméra directe, le canvas est hors de cause : c'est la caméra ou le
      // système qui a coupé, et il faut le dire au lieu de promettre un repli.
      setLiveStatus(usingRawTrack
        ? '⚠️ Aucune image envoyée — caméra bloquée par le téléphone ?'
        : '⚠️ Aucune image envoyée — repli en cours…', 'err');
      fallbackToRawCameraTrack(activeCall, 'aucune frame envoyée');
    } else if (dBytes <= 0) {
      setLiveStatus('⚠️ Vidéo non transmise (0 octet)', 'err');
    } else {
      setLiveStatus(`● En direct — ${Math.round(dFrames / PERIOD_S)} img/s (${cur.route})`, 'live');
    }
  }, PERIOD_S * 1000);
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
    applyPreviewTransform(); // ré-applique miroir (selfie) + rotation courante
    // L'ancienne piste caméra vient d'être arrêtée. Si c'était ELLE qu'on
    // envoyait (mode direct), la connexion tient une piste morte → image figée
    // côté Studio. On republie donc la nouvelle piste sans attendre.
    rawVideoTrack = newVideoTrack;
    cropIsIdentity = isCropIdentity();
    tuneOutgoingTrack(rawVideoTrack);
    if (usingRawTrack) {
      usingRawTrack = false; // force syncVideoSendMode à repousser une piste
      await syncVideoSendMode('bascule caméra');
    }
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
