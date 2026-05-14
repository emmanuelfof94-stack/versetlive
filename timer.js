// Module Minuteur — chronomètre + compte à rebours, sync entre panneau / présentateur
// Réutilise CHANNEL_NAME, bc, toast définis dans app.js

(function () {
  const TIMER_KEY = 'versetlive:timer';
  const TIMER_CHANNEL = 'versetlive:timer';

  let state = {
    mode: 'stopwatch',     // 'stopwatch' | 'countdown'
    duration: 30 * 60,     // secondes (compte à rebours)
    running: false,
    startTs: null,         // timestamp ms quand le run courant a démarré
    accumulatedMs: 0,      // ms écoulées des runs précédents (avant pause)
  };

  const els = {
    display: document.getElementById('timerDisplay'),
    modeTag: document.getElementById('timerModeTag'),
    startBtn: document.getElementById('timerStartBtn'),
    pauseBtn: document.getElementById('timerPauseBtn'),
    resetBtn: document.getElementById('timerResetBtn'),
    modeBtns: document.querySelectorAll('.timer-mode-btn'),
    presets: document.getElementById('timerPresets'),
    presetBtns: document.querySelectorAll('#timerPresets [data-min]'),
    customMin: document.getElementById('timerCustomMin'),
  };

  const tbc = (() => { try { return new BroadcastChannel(TIMER_CHANNEL); } catch { return null; } })();

  function elapsedMs() {
    return state.accumulatedMs + (state.running && state.startTs ? Date.now() - state.startTs : 0);
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

  function render() {
    const elapsed = elapsedMs();
    let displaySec, level;

    if (state.mode === 'countdown') {
      const remainingMs = state.duration * 1000 - elapsed;
      displaySec = Math.ceil(remainingMs / 1000);
      // Niveaux d'alerte sur le compte à rebours
      const remainingSec = remainingMs / 1000;
      if (remainingSec < 0) level = 'over';
      else if (remainingSec <= 60) level = 'critical';
      else if (remainingSec <= 300) level = 'warning';
      else level = '';
    } else {
      displaySec = Math.floor(elapsed / 1000);
      level = '';
    }

    els.display.textContent = formatTime(displaySec);
    els.display.classList.remove('warning', 'critical', 'over');
    if (level) els.display.classList.add(level);

    let tag;
    if (!state.running && elapsed === 0) tag = 'À l\'arrêt';
    else if (!state.running) tag = 'En pause';
    else if (state.mode === 'countdown') tag = 'Compte à rebours en cours';
    else tag = 'Chronomètre en cours';
    els.modeTag.textContent = tag;

    els.startBtn.style.display = state.running ? 'none' : '';
    els.pauseBtn.style.display = state.running ? '' : 'none';
  }

  function persistAndBroadcast() {
    localStorage.setItem(TIMER_KEY, JSON.stringify(state));
    tbc?.postMessage({ type: 'timer-state', payload: state });
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.startTs = Date.now();
    persistAndBroadcast();
    render();
  }

  function pause() {
    if (!state.running) return;
    state.accumulatedMs += Date.now() - state.startTs;
    state.running = false;
    state.startTs = null;
    persistAndBroadcast();
    render();
  }

  function reset() {
    state.running = false;
    state.startTs = null;
    state.accumulatedMs = 0;
    persistAndBroadcast();
    render();
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    state.running = false;
    state.startTs = null;
    state.accumulatedMs = 0;
    els.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    els.presets.hidden = mode !== 'countdown';
    persistAndBroadcast();
    render();
  }

  function setDuration(minutes) {
    state.duration = Math.max(1, Math.floor(minutes)) * 60;
    state.running = false;
    state.startTs = null;
    state.accumulatedMs = 0;
    els.presetBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.min) === minutes));
    persistAndBroadcast();
    render();
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
      if (saved) state = { ...state, ...saved };
    } catch {}
    els.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
    els.presets.hidden = state.mode !== 'countdown';
    els.presetBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.min) * 60 === state.duration));
    render();
  }

  // Bindings
  els.startBtn.addEventListener('click', start);
  els.pauseBtn.addEventListener('click', pause);
  els.resetBtn.addEventListener('click', reset);

  els.modeBtns.forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  els.presetBtns.forEach(b => {
    b.addEventListener('click', () => setDuration(parseInt(b.dataset.min)));
  });

  els.customMin.addEventListener('change', () => {
    const val = parseInt(els.customMin.value);
    if (val > 0) setDuration(val);
  });

  // Mise à jour fluide (4 fois/seconde)
  setInterval(() => { if (state.running) render(); }, 250);

  // Réception d'ordres venant du présentateur
  tbc?.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'timer-cmd') {
      if (msg.cmd === 'start') start();
      else if (msg.cmd === 'pause') pause();
      else if (msg.cmd === 'reset') reset();
      else if (msg.cmd === 'toggle') (state.running ? pause() : start());
    }
  });

  restore();
  // Diffuser l'état au démarrage pour synchroniser une fenêtre présentateur déjà ouverte
  persistAndBroadcast();
})();
