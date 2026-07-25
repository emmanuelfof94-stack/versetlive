// Tableau de bord VersetLive
// Vue centrale : état de la diffusion en temps réel + accès rapide à tous les
// outils + historique re-diffusable. N'introduit aucun nouveau format d'état :
// il lit et écrit exactement les mêmes clés que le panneau principal (app.js),
// si bien que toutes les surfaces (OBS, TV, présentateur, studio) restent
// synchronisées.

const CHANNEL_NAME = 'versetlive';
const STORAGE_KEY = 'versetlive:state';
const STYLE_KEY = 'versetlive:style';
const HISTORY_KEY = 'versetlive:history';
const TIMER_KEY = 'versetlive:timer';
const TIMER_CHANNEL = 'versetlive:timer';

const bc = (() => { try { return new BroadcastChannel(CHANNEL_NAME); } catch { return null; } })();
const tbc = (() => { try { return new BroadcastChannel(TIMER_CHANNEL); } catch { return null; } })();

const els = {
  liveDot: document.getElementById('liveDot'),
  liveStatus: document.getElementById('liveStatus'),
  topClock: document.getElementById('topClock'),
  onairTag: document.getElementById('onairTag'),
  onairTagText: document.getElementById('onairTagText'),
  onairKind: document.getElementById('onairKind'),
  onairBody: document.getElementById('onairBody'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  clearBtn: document.getElementById('clearBtn'),
  timerValue: document.getElementById('timerValue'),
  timerTag: document.getElementById('timerTag'),
  tStart: document.getElementById('tStart'),
  tPause: document.getElementById('tPause'),
  tReset: document.getElementById('tReset'),
  bigClock: document.getElementById('bigClock'),
  toolsGrid: document.getElementById('toolsGrid'),
  histList: document.getElementById('histList'),
  statHistory: document.getElementById('statHistory'),
  statCurrent: document.getElementById('statCurrent'),
  toast: document.getElementById('toast'),
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

// ====== HORLOGE ======
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  els.topClock.textContent = `${h}:${m}:${s}`;
  els.bigClock.textContent = `${h}:${m}:${s}`;
}
setInterval(updateClock, 1000);
updateClock();

// ====== À L'ANTENNE ======
// Reflète l'état courant. Trois familles de contenu, comme le présentateur :
// titre (kind: 'title'), chant (kind: 'song' + méta) et verset (text simple).
function renderOnAir(state) {
  const live = !!(state && (state.text || (state.kind === 'title' && state.title)));

  els.liveDot.classList.toggle('live', live);
  els.liveStatus.textContent = live ? 'En direct' : 'En attente';
  els.onairTag.classList.toggle('live', live);

  if (!live) {
    els.onairTagText.textContent = 'En attente';
    els.onairKind.textContent = 'À l\'antenne';
    els.onairBody.innerHTML = '<div class="onair-empty">Aucun contenu diffusé</div>';
    els.statCurrent.textContent = '—';
    return;
  }

  if (state.kind === 'title' && state.title) {
    els.onairTagText.textContent = 'En direct';
    els.onairKind.textContent = '✨ Titre';
    els.onairBody.innerHTML = `
      <div class="onair-text" style="font-weight:800;">${escapeHtml(state.title)}</div>
      ${state.subtitle ? `<div class="onair-ref">${escapeHtml(state.subtitle)}</div>` : ''}`;
    els.statCurrent.textContent = 'Titre';
    return;
  }

  // Verset ou chant
  const isSong = state.kind === 'song';
  els.onairTagText.textContent = 'En direct';
  els.onairKind.textContent = isSong ? '🎵 Chant' : '📖 Verset';

  let songBadge = '';
  if (isSong) {
    const section = state.sectionLabel || (state.sectionIndex != null ? `Section ${state.sectionIndex + 1}` : '');
    const number = state.songNumber ? `n°${escapeHtml(String(state.songNumber))} · ` : '';
    const title = state.songTitle ? escapeHtml(state.songTitle) : '';
    songBadge = `<div class="song-badge">${number}${title}${section ? ' — ' + escapeHtml(section) : ''}</div>`;
  }

  const ref = state.reference
    ? `<div class="onair-ref">${escapeHtml(state.reference)}${state.translation ? ' (' + escapeHtml(state.translation) + ')' : ''}</div>`
    : '';

  els.onairBody.innerHTML = `
    <div class="onair-text">« ${escapeHtml(state.text)} »</div>
    ${ref}
    ${songBadge}`;

  els.statCurrent.textContent = isSong ? 'Chant' : 'Verset';
}

function readState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch { return null; }
}

function currentStyle(fallbackState) {
  if (fallbackState && fallbackState.style) return fallbackState.style;
  try { return JSON.parse(localStorage.getItem(STYLE_KEY) || 'null') || {}; }
  catch { return {}; }
}

// ====== CONTRÔLES DE DIFFUSION ======
// Effacer : autonome, identique à clearLive() du panneau — écrit l'état vide et
// diffuse 'clear' à toutes les surfaces.
els.clearBtn.addEventListener('click', () => {
  const state = readState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ style: currentStyle(state) }));
  bc?.postMessage({ type: 'clear' });
  renderOnAir(null);
  toast('Écran effacé');
});

// Précédent / Suivant : délégués au panneau principal (il détient le chapitre
// courant et la logique cross-chapitre). Sans panneau ouvert, rien ne répond —
// d'où l'indication sous les boutons.
els.prevBtn.addEventListener('click', () => bc?.postMessage({ type: 'nav', action: 'prev' }));
els.nextBtn.addEventListener('click', () => bc?.postMessage({ type: 'nav', action: 'next' }));

// Re-diffuser depuis l'historique : autonome, reconstruit un état 'show' complet
// avec le style courant, comme broadcastVerse(). Fonctionne pour les versets.
function replay(entry) {
  const state = {
    reference: entry.reference,
    text: entry.text,
    translation: entry.translation,
    style: currentStyle(readState()),
    ts: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  bc?.postMessage({ type: 'show', payload: state });
  renderOnAir(state);
  toast('Diffusion : ' + (entry.reference || 'verset'));
}

// ====== HISTORIQUE ======
function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function renderHistory() {
  const history = readHistory();
  els.statHistory.textContent = history.length;

  if (!history.length) {
    els.histList.innerHTML = '<div class="empty">Aucun verset diffusé</div>';
    return;
  }

  els.histList.innerHTML = history.map((h, i) => `
    <div class="hist-item" data-i="${i}">
      <div class="hist-main">
        <div class="hist-ref">${escapeHtml(h.reference || 'Verset')}${h.translation ? ' <span style="color:var(--text-secondary); font-weight:400;">· ' + escapeHtml(h.translation) + '</span>' : ''}</div>
        <div class="hist-text">${escapeHtml(h.text || '')}</div>
      </div>
      <div class="hist-replay">▶ Diffuser</div>
    </div>`).join('');

  els.histList.querySelectorAll('.hist-item').forEach(node => {
    node.addEventListener('click', () => {
      const i = parseInt(node.dataset.i, 10);
      const entry = readHistory()[i];
      if (entry) replay(entry);
    });
  });
}

// ====== OUTILS ======
const TOOLS = [
  { href: '/', icon: '📖', name: 'Panneau principal', desc: 'Sélection verset / chant / titre, contrôle du direct', target: '_self' },
  { href: 'studio.html', icon: '🎬', name: 'Studio', desc: 'Mixeur multi-caméras, enregistrement, streaming RTMP' },
  { href: 'presenter.html', icon: '👁', name: 'Présentateur', desc: 'Vue orateur : contenu en cours + minuteur' },
  { href: 'tv.html', icon: '📺', name: 'TV', desc: 'À ouvrir sur la TV — affiche le code de pairage' },
  { href: 'studio-output.html', icon: '🖥', name: 'Sortie projecteur', desc: 'Fenêtre dédiée pour le second écran' },
  { href: 'studio-camera.html', icon: '📱', name: 'Caméra téléphone', desc: 'Page caméra accessible via QR code' },
  { href: 'cv-paroles.html', icon: '🎼', name: 'Paroles CV', desc: 'Lecteur de paroles — Chants de victoire' },
  { href: 'obs.html', icon: '🎥', name: 'Vue OBS', desc: 'Vue plein écran à capturer dans OBS Studio' },
];

function renderTools() {
  els.toolsGrid.innerHTML = TOOLS.map(t => `
    <a class="tool-card" href="${t.href}"${t.target ? '' : ' target="_blank" rel="noopener"'}>
      <div class="tool-icon">${t.icon}</div>
      <div>
        <div class="tool-name">${t.name}</div>
        <div class="tool-desc">${t.desc}</div>
      </div>
    </a>`).join('');
}

// ====== MINUTEUR (miroir + commandes) ======
// Même protocole que le présentateur : on affiche l'état et on envoie des
// commandes ; c'est timer.js (côté panneau) qui détient l'autorité.
let timerState = { mode: 'stopwatch', duration: 30 * 60, running: false, startTs: null, accumulatedMs: 0 };

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
  let displaySec, level = '';

  if (timerState.mode === 'countdown') {
    const remainingMs = timerState.duration * 1000 - elapsed;
    displaySec = Math.ceil(remainingMs / 1000);
    const remainingSec = remainingMs / 1000;
    if (remainingSec < 0) level = 'over';
    else if (remainingSec <= 60) level = 'critical';
    else if (remainingSec <= 300) level = 'warning';
  } else {
    displaySec = Math.floor(elapsed / 1000);
  }

  els.timerValue.textContent = formatTime(displaySec);
  els.timerValue.classList.remove('warning', 'critical', 'over');
  if (level) els.timerValue.classList.add(level);

  let tag;
  if (!timerState.running && elapsed === 0) tag = 'À l\'arrêt';
  else if (!timerState.running) tag = 'En pause';
  else if (timerState.mode === 'countdown') tag = 'Compte à rebours';
  else tag = 'Chronomètre';
  els.timerTag.textContent = tag;

  els.tStart.style.display = timerState.running ? 'none' : '';
  els.tPause.style.display = timerState.running ? '' : 'none';
}

function sendTimerCmd(cmd) { tbc?.postMessage({ type: 'timer-cmd', cmd }); }
els.tStart.addEventListener('click', () => sendTimerCmd('start'));
els.tPause.addEventListener('click', () => sendTimerCmd('pause'));
els.tReset.addEventListener('click', () => sendTimerCmd('reset'));

// ====== ÉCOUTE TEMPS RÉEL ======
bc?.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'show') renderOnAir(msg.payload);
  else if (msg.type === 'showTitle') renderOnAir({ ...msg.payload, kind: 'title' });
  else if (msg.type === 'clear') renderOnAir(null);
  // Un nouveau verset diffusé alimente l'historique via app.js ; on rafraîchit
  // notre liste juste après pour rester synchro même sans event 'storage'
  // (même onglet exclu ici, mais l'inter-onglets passe par 'storage').
});

tbc?.addEventListener('message', (e) => {
  if (e.data?.type === 'timer-state') { timerState = e.data.payload; renderTimer(); }
});

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) renderOnAir(e.newValue ? (() => { try { return JSON.parse(e.newValue); } catch { return null; } })() : null);
  else if (e.key === HISTORY_KEY) renderHistory();
  else if (e.key === TIMER_KEY && e.newValue) { try { timerState = JSON.parse(e.newValue); renderTimer(); } catch {} }
});

// Rendu à intervalle pour le minuteur en marche (pas d'event pendant qu'il court).
setInterval(() => { if (timerState.running) renderTimer(); }, 250);

// ====== INIT ======
try {
  const savedTimer = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
  if (savedTimer) timerState = { ...timerState, ...savedTimer };
} catch {}

renderTools();
renderOnAir(readState());
renderHistory();
renderTimer();
