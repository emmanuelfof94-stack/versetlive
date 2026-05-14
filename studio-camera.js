// Page téléphone : capture caméra + micro et envoie en WebRTC P2P au Studio.
// Signaling via PeerJS Cloud (broker public).

const PEER_PREFIX = 'versetlive-studio-';

const $ = id => document.getElementById(id);
const setup = $('setupScreen');
const live = $('liveScreen');
const roomInput = $('roomInput');
const facingSelect = $('facingSelect');
const connectBtn = $('connectBtn');
const setupError = $('setupError');
const preview = $('preview');
const liveDot = $('liveDot');
const liveStatusText = $('liveStatusText');
const liveRoomTag = $('liveRoomTag');
const switchBtn = $('switchBtn');
const muteBtn = $('muteBtn');
const muteLabel = $('muteLabel');
const stopBtn = $('stopBtn');

let stream = null;
let peer = null;
let call = null;
let roomCode = '';
let facing = 'environment';
let audioMuted = false;

// Pré-remplir le code via ?room=
const params = new URLSearchParams(location.search);
const roomFromUrl = params.get('room');
if (roomFromUrl) {
  roomInput.value = roomFromUrl.toUpperCase();
  // Auto-focus le bouton plutôt que l'input (UX QR scan)
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
  if (document.visibilityState === 'visible' && stream && !wakeLock) requestWakeLock();
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
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
  } catch (e) {
    connectBtn.disabled = false;
    connectBtn.textContent = '▶ Se connecter';
    return showError('Caméra/micro refusés : ' + e.message);
  }

  preview.srcObject = stream;
  preview.classList.toggle('mirror', facing === 'user');
  setup.style.display = 'none';
  live.classList.add('show');
  liveRoomTag.textContent = roomCode;
  setLiveStatus('Connexion…');
  requestWakeLock();

  await connectToStudio();
}

async function connectToStudio() {
  peer = new Peer({ debug: 1 });

  peer.on('open', () => {
    // Appeler le studio
    const targetId = PEER_PREFIX + roomCode;
    setLiveStatus('Appel du Studio…');
    call = peer.call(targetId, stream);
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

    // PeerConnection state
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
    // Stopper les tracks vidéo actuels
    stream.getVideoTracks().forEach(t => t.stop());
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const newVideoTrack = newStream.getVideoTracks()[0];

    // Remplacer la track dans le MediaStream local
    const oldVideoTrack = stream.getVideoTracks()[0];
    if (oldVideoTrack) stream.removeTrack(oldVideoTrack);
    stream.addTrack(newVideoTrack);
    preview.srcObject = stream;
    preview.classList.toggle('mirror', facing === 'user');

    // Remplacer la track dans le RTCPeerConnection
    if (call && call.peerConnection) {
      const senders = call.peerConnection.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) await videoSender.replaceTrack(newVideoTrack);
    }
  } catch (e) {
    showLiveToast('Bascule caméra impossible : ' + e.message);
  }
}

function toggleMute() {
  audioMuted = !audioMuted;
  stream.getAudioTracks().forEach(t => t.enabled = !audioMuted);
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
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (wakeLock) try { wakeLock.release(); } catch (e) {}
  stream = null; peer = null; call = null;
}

window.addEventListener('beforeunload', cleanup);

function showLiveToast(msg) {
  // Réutilise le status pill pendant 3 sec
  const prev = liveStatusText.textContent;
  setLiveStatus(msg);
  setTimeout(() => setLiveStatus(prev, 'live'), 3000);
}
