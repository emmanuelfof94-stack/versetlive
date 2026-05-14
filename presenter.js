// Vue présentateur — affiche le contenu en cours + minuteur grand format

const STORAGE_KEY = 'versetlive:state';
const TIMER_KEY = 'versetlive:timer';
const CHANNEL_NAME = 'versetlive';
const TIMER_CHANNEL = 'versetlive:timer';

const els = {
  clock: document.getElementById('clock'),
  bigClock: document.getElementById('bigClock'),
  onAir: document.getElementById('onAir'),
  stageLabel: document.getElementById('stageLabel'),
  mirror: document.getElementById('mirrorContent'),
  bigTimer: document.getElementById('bigTimer'),
  bigTimerTag: document.getElementById('bigTimerTag'),
  pStart: document.getElementById('pStart'),
  pPause: document.getElementById('pPause'),
  pReset: document.getElementById('pReset'),
  progressFill: document.getElementById('progressFill'),
};

let timerState = {
  mode: 'stopwatch',
  duration: 30 * 60,
  running: false,
  startTs: null,
  accumulatedMs: 0,
};

// ====== HORLOGE ======
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  els.clock.textContent = `${h}:${m}:${s}`;
  els.bigClock.textContent = `${h}:${m}`;
}
setInterval(updateClock, 500);
updateClock();

// ====== MIROIR DE DIFFUSION ======
function updateMirror(state) {
  if (!state) {
    els.onAir.textContent = 'EN ATTENTE';
    els.onAir.classList.remove('live');
    els.mirror.className = 'mirror-empty';
    els.mirror.textContent = 'Aucun verset diffusé';
    return;
  }

  if (state.kind === 'title' && state.title) {
    els.onAir.textContent = '✨ TITRE DIFFUSÉ';
    els.onAir.classList.add('live');
    els.stageLabel.textContent = 'TITRE À L\'ANTENNE';
    els.mirror.className = '';
    els.mirror.innerHTML = `
      <div style="font-size: clamp(36px, 5vw, 72px); font-weight: 800; letter-spacing: 0.04em;">${escapeHtml(state.title)}</div>
      ${state.subtitle ? `<div class="mirror-ref" style="margin-top: 16px;">${escapeHtml(state.subtitle)}</div>` : ''}
    `;
  } else if (state.text) {
    els.onAir.textContent = '🔴 EN DIRECT';
    els.onAir.classList.add('live');
    els.stageLabel.textContent = 'VERSET À L\'ANTENNE';
    els.mirror.className = '';
    els.mirror.innerHTML = `
      <div class="mirror-text">« ${escapeHtml(state.text)} »</div>
      ${state.reference ? `<div class="mirror-ref">${escapeHtml(state.reference)}${state.translation ? ' (' + escapeHtml(state.translation) + ')' : ''}</div>` : ''}
    `;
  } else {
    els.onAir.textContent = 'EN ATTENTE';
    els.onAir.classList.remove('live');
    els.stageLabel.textContent = 'À L\'ANTENNE';
    els.mirror.className = 'mirror-empty';
    els.mirror.textContent = 'Aucun verset diffusé';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// État initial
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  updateMirror(saved);
} catch { updateMirror(null); }

// Écouter les diffusions de versets/titres
try {
  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'show') updateMirror(msg.payload);
    else if (msg.type === 'showTitle') updateMirror(msg.payload);
    else if (msg.type === 'clear') updateMirror(null);
  });
} catch {}

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    try { updateMirror(e.newValue ? JSON.parse(e.newValue) : null); } catch {}
  } else if (e.key === TIMER_KEY) {
    try { if (e.newValue) { timerState = JSON.parse(e.newValue); renderTimer(); } } catch {}
  }
});

// ====== MINUTEUR ======
const tbc = (() => { try { return new BroadcastChannel(TIMER_CHANNEL); } catch { return null; } })();

function elapsedMs() {
  return timerState.accumulatedMs + (timerState.running && timerState.startTs ? Date.now() - timerState.startTs : 0);
}

function formatTime(totalSeconds) {
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(Math.floor(totalSeconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderTimer() {
  const elapsed = elapsedMs();
  let displaySec, level, progressPct = 0;

  if (timerState.mode === 'countdown') {
    const remainingMs = timerState.duration * 1000 - elapsed;
    displaySec = Math.ceil(remainingMs / 1000);
    const remainingSec = remainingMs / 1000;
    if (remainingSec < 0) level = 'over';
    else if (remainingSec <= 60) level = 'critical';
    else if (remainingSec <= 300) level = 'warning';
    else level = '';
    progressPct = Math.max(0, Math.min(100, (elapsed / (timerState.duration * 1000)) * 100));
  } else {
    displaySec = Math.floor(elapsed / 1000);
    level = '';
    progressPct = 0;
  }

  els.bigTimer.textContent = formatTime(displaySec);
  els.bigTimer.classList.remove('warning', 'critical', 'over');
  if (level) els.bigTimer.classList.add(level);

  let tag;
  if (!timerState.running && elapsed === 0) tag = 'À l\'arrêt';
  else if (!timerState.running) tag = 'En pause';
  else if (timerState.mode === 'countdown') tag = 'Compte à rebours';
  else tag = 'Chronomètre';
  els.bigTimerTag.textContent = tag;

  els.pStart.style.display = timerState.running ? 'none' : '';
  els.pPause.style.display = timerState.running ? '' : 'none';

  els.progressFill.style.width = progressPct + '%';
}

// Chargement initial du minuteur
try {
  const saved = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
  if (saved) timerState = { ...timerState, ...saved };
} catch {}
renderTimer();

// Écouter l'état du minuteur
tbc?.addEventListener('message', (e) => {
  if (e.data?.type === 'timer-state') {
    timerState = e.data.payload;
    renderTimer();
  }
});

// Boucle de rendu
setInterval(() => { if (timerState.running) renderTimer(); }, 250);

// Boutons : envoyer un ordre au panneau de contrôle
function sendCmd(cmd) {
  tbc?.postMessage({ type: 'timer-cmd', cmd });
}
els.pStart.addEventListener('click', () => sendCmd('start'));
els.pPause.addEventListener('click', () => sendCmd('pause'));
els.pReset.addEventListener('click', () => sendCmd('reset'));

// Raccourcis
document.addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    sendCmd('toggle');
  } else if (e.key === 'r' || e.key === 'R') {
    sendCmd('reset');
  } else if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
});
