// Gestion des chants — UI, CRUD, import/export, broadcast vers OBS

let allSongs = loadSongs();
let activeSongId = null;
let activeSectionIndex = -1;
let editingSongId = null;

const AUTO_DURATION_KEY = 'versetlive:autoDuration';
const AUTO_MODE_KEY = 'versetlive:autoMode';
const AUTO_SPEED_KEY = 'versetlive:autoSpeed';
const BASE_WPM = 110; // mots par minute en chant (rythme moyen)

let autoState = {
  active: false,
  paused: false,
  sequence: [],
  position: 0,
  mode: localStorage.getItem(AUTO_MODE_KEY) || 'adaptive', // 'adaptive' | 'fixed'
  duration: parseInt(localStorage.getItem(AUTO_DURATION_KEY)) || 12000,
  speed: parseFloat(localStorage.getItem(AUTO_SPEED_KEY)) || 1.0,
  remaining: 0,
  currentDuration: 0,
  timerId: null,
  tickId: null,
  endsAt: 0,
};

function computeStepDuration(section) {
  if (autoState.mode === 'fixed') {
    return Math.round(autoState.duration / autoState.speed);
  }
  // Mode adaptatif : calcul depuis le nombre de mots
  const text = (section?.text || '').trim();
  if (!text) return 5000;
  const words = text.split(/\s+/).filter(Boolean).length;
  const wpm = BASE_WPM * autoState.speed;
  const seconds = (words / wpm) * 60;
  return Math.max(3000, Math.min(60000, Math.round(seconds * 1000)));
}

function speedLabel(speed) {
  if (speed <= 0.6) return 'Très lent';
  if (speed <= 0.85) return 'Lent';
  if (speed <= 1.15) return 'Normal';
  if (speed <= 1.5) return 'Rapide';
  return 'Très rapide';
}

// Vue active : 'songs' (cantiques) ou 'louange' (chants modernes)
function activeSongTab() {
  const t = document.querySelector('.tab.active')?.dataset.tab;
  return t === 'louange' ? 'louange' : 'songs';
}

const songsEls = {
  search: document.getElementById('songSearch'),
  list: document.getElementById('songsList'),
  count: document.getElementById('songCount'),
  detail: document.getElementById('songDetail'),
  newBtn: document.getElementById('newSongBtn'),
  importBtn: document.getElementById('importSongsBtn'),
  exportBtn: document.getElementById('exportSongsBtn'),
  importFile: document.getElementById('importFile'),

  // Louange (mêmes fonctions, autres éléments)
  louangeSearch: document.getElementById('louangeSearch'),
  louangeList: document.getElementById('louangeList'),
  louangeCount: document.getElementById('louangeCount'),
  louangeNewBtn: document.getElementById('newLouangeBtn'),
  louangeImportBtn: document.getElementById('importLouangeBtn'),
  louangeExportBtn: document.getElementById('exportLouangeBtn'),
  louangeImportFile: document.getElementById('louangeImportFile'),

  modal: document.getElementById('songModal'),
  modalTitle: document.getElementById('songModalTitle'),
  modalClose: document.getElementById('songModalClose'),
  fNumber: document.getElementById('songFormNumber'),
  fTitle: document.getElementById('songFormTitle'),
  fAuthor: document.getElementById('songFormAuthor'),
  fBook: document.getElementById('songFormBook'),
  sectionsList: document.getElementById('songFormSections'),
  addVerseBtn: document.getElementById('songAddVerseBtn'),
  addChorusBtn: document.getElementById('songAddChorusBtn'),
  addBridgeBtn: document.getElementById('songAddBridgeBtn'),
  saveBtn: document.getElementById('songSaveBtn'),
  cancelBtn: document.getElementById('songCancelBtn'),
  deleteBtn: document.getElementById('songDeleteBtn'),
};

// ====== LIST ======
function renderSongsList() {
  renderListInto({
    listEl: songsEls.list,
    countEl: songsEls.count,
    searchEl: songsEls.search,
    sourceFilter: (s) => !isLouangeSong(s),
    emptyMsg: 'Aucun chant. Clique "+ Nouveau" ou "📚 Recueil 1926" pour charger 308 cantiques.',
  });
  renderListInto({
    listEl: songsEls.louangeList,
    countEl: songsEls.louangeCount,
    searchEl: songsEls.louangeSearch,
    sourceFilter: (s) => isLouangeSong(s),
    emptyMsg: 'Aucun chant de louange. Clique "+ Nouveau" pour saisir un chant ou "📥 Importer" pour charger un JSON.',
  });
}

function renderListInto({ listEl, countEl, searchEl, sourceFilter, emptyMsg }) {
  if (!listEl || !countEl) return;
  const q = (searchEl?.value || '').toLowerCase().trim();
  let pool = allSongs.filter(sourceFilter);
  let filtered = pool;
  if (q) {
    filtered = pool.filter(s => {
      const haystack = [
        s.number || '',
        s.title || '',
        s.author || '',
        s.book || '',
        ...(s.sections || []).map(sec => sec.text || ''),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  filtered.sort((a, b) => {
    const na = parseInt(a.number) || 9999;
    const nb = parseInt(b.number) || 9999;
    if (na !== nb) return na - nb;
    return (a.title || '').localeCompare(b.title || '');
  });

  countEl.textContent = `${filtered.length} chant${filtered.length > 1 ? 's' : ''}${q ? ` (sur ${pool.length})` : ''}`;

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(s => `
    <div class="song-row ${s.id === activeSongId ? 'active' : ''}" data-id="${s.id}">
      <span class="song-num">${escapeHtml(s.number || '—')}</span>
      <div class="song-meta">
        <div class="song-title">${escapeHtml(s.title || '(sans titre)')}</div>
        <div class="song-sub">${escapeHtml(s.book || '')}${s.author ? ' · ' + escapeHtml(s.author) : ''}</div>
      </div>
    </div>
  `).join('');
  listEl.querySelectorAll('.song-row').forEach(row => {
    row.addEventListener('click', () => selectSong(row.dataset.id));
  });
}

function selectSong(id) {
  if (activeSongId !== id) stopAutoPlay();
  activeSongId = id;
  activeSectionIndex = -1;
  renderSongsList();
  renderSongDetail();
}

// ====== AUTO-PLAY (V1 → R → V2 → R → ...) ======
function buildAutoSequence(song) {
  const sections = song.sections || [];
  if (!sections.length) return [];
  const idxOf = (t) => sections
    .map((s, i) => ({ s, i }))
    .filter(x => (x.s.type || 'verse') === t)
    .map(x => x.i);

  const verses = idxOf('verse');
  const choruses = idxOf('chorus');
  const prechoruses = idxOf('prechorus');
  const bridges = idxOf('bridge');
  const endings = idxOf('ending');

  // Aucun couplet : on enchaîne tel quel
  if (!verses.length) return sections.map((_, i) => i);

  const seq = [];
  verses.forEach((vi, idx) => {
    seq.push(vi);
    if (prechoruses.length) {
      seq.push(prechoruses[Math.min(idx, prechoruses.length - 1)]);
    }
    if (choruses.length) {
      seq.push(choruses[Math.min(idx, choruses.length - 1)]);
    }
  });
  bridges.forEach(b => seq.push(b));
  if (bridges.length && choruses.length) {
    seq.push(choruses[choruses.length - 1]); // Reprise du refrain après le pont
  }
  endings.forEach(e => seq.push(e));
  return seq;
}

function startAutoPlay() {
  const song = allSongs.find(s => s.id === activeSongId);
  if (!song) return;
  const seq = buildAutoSequence(song);
  if (!seq.length) {
    if (typeof toast === 'function') toast('Ce chant n\'a aucune section');
    return;
  }
  stopAutoPlay(true);
  autoState.active = true;
  autoState.paused = false;
  autoState.sequence = seq;
  autoState.position = 0;
  playCurrentStep();
}

function playCurrentStep() {
  if (!autoState.active) return;
  const song = allSongs.find(s => s.id === activeSongId);
  if (!song) return stopAutoPlay();

  if (autoState.position >= autoState.sequence.length) {
    stopAutoPlay();
    if (typeof toast === 'function') toast('Diffusion auto terminée');
    return;
  }

  const sectionIdx = autoState.sequence[autoState.position];
  activeSectionIndex = sectionIdx;
  // Diffuse la section sur l'écran OBS
  const sec = song.sections[sectionIdx];
  if (sec) pushSongSection(song, sectionIdx, sec);
  renderSongDetail();
  scheduleNextStep();
}

function scheduleNextStep() {
  clearAutoTimers();
  if (!autoState.active || autoState.paused) return;
  const song = allSongs.find(s => s.id === activeSongId);
  const sectionIdx = autoState.sequence[autoState.position];
  const section = song?.sections?.[sectionIdx];
  const stepDuration = computeStepDuration(section);
  autoState.currentDuration = stepDuration;
  autoState.endsAt = Date.now() + stepDuration;
  autoState.remaining = stepDuration;
  autoState.timerId = setTimeout(() => {
    autoState.position++;
    playCurrentStep();
  }, stepDuration);
  autoState.tickId = setInterval(() => {
    autoState.remaining = Math.max(0, autoState.endsAt - Date.now());
    updateAutoProgressUI();
  }, 150);
}

function clearAutoTimers() {
  if (autoState.timerId) { clearTimeout(autoState.timerId); autoState.timerId = null; }
  if (autoState.tickId) { clearInterval(autoState.tickId); autoState.tickId = null; }
}

function pauseOrResumeAutoPlay() {
  if (!autoState.active) return;
  autoState.paused = !autoState.paused;
  if (autoState.paused) {
    autoState.remaining = Math.max(0, autoState.endsAt - Date.now());
    clearAutoTimers();
    renderSongDetail();
  } else {
    const remaining = autoState.remaining || autoState.currentDuration || 5000;
    autoState.endsAt = Date.now() + remaining;
    autoState.timerId = setTimeout(() => {
      autoState.position++;
      playCurrentStep();
    }, remaining);
    autoState.tickId = setInterval(() => {
      autoState.remaining = Math.max(0, autoState.endsAt - Date.now());
      updateAutoProgressUI();
    }, 150);
    renderSongDetail();
  }
}

function autoSkipNext() {
  if (!autoState.active) return;
  autoState.position++;
  playCurrentStep();
}

function autoSkipPrev() {
  if (!autoState.active) return;
  autoState.position = Math.max(0, autoState.position - 1);
  playCurrentStep();
}

function stopAutoPlay(silent) {
  clearAutoTimers();
  autoState.active = false;
  autoState.paused = false;
  autoState.position = 0;
  autoState.sequence = [];
  if (!silent) renderSongDetail();
}

function setAutoDuration(seconds) {
  const ms = Math.max(2000, Math.min(60000, Math.round(seconds * 1000)));
  autoState.duration = ms;
  localStorage.setItem(AUTO_DURATION_KEY, String(ms));
  // Si en cours, n'affecte pas la section courante (le timer continue)
}

function updateAutoProgressUI() {
  const bar = document.getElementById('autoProgressBar');
  const cnt = document.getElementById('autoCountdown');
  const total = autoState.currentDuration || autoState.duration;
  if (bar) {
    const pct = Math.max(0, Math.min(100, 100 * (1 - autoState.remaining / total)));
    bar.style.width = pct + '%';
  }
  if (cnt) {
    cnt.textContent = (autoState.remaining / 1000).toFixed(1) + 's';
  }
}

function setAutoMode(mode) {
  autoState.mode = mode === 'fixed' ? 'fixed' : 'adaptive';
  localStorage.setItem(AUTO_MODE_KEY, autoState.mode);
}

function setAutoSpeed(speed) {
  autoState.speed = Math.max(0.5, Math.min(2.0, parseFloat(speed) || 1.0));
  localStorage.setItem(AUTO_SPEED_KEY, String(autoState.speed));
}

function renderSongDetail() {
  const song = allSongs.find(s => s.id === activeSongId);
  if (!song) {
    songsEls.detail.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <p class="hint">Sélectionne un chant à gauche, ou crée-en un nouveau.</p>
      </div>`;
    return;
  }
  const sections = song.sections || [];
  const sequence = buildAutoSequence(song);
  const stepIdx = autoState.active ? autoState.sequence[autoState.position] : -1;
  const sequencePositions = {}; // sectionIndex → array of step positions
  sequence.forEach((secIdx, pos) => {
    if (!sequencePositions[secIdx]) sequencePositions[secIdx] = [];
    sequencePositions[secIdx].push(pos + 1);
  });

  const durationSec = (autoState.duration / 1000).toFixed(0);
  const autoBar = autoState.active ? `
    <div class="auto-bar">
      <div class="auto-bar-progress" id="autoProgressBar"></div>
      <div class="auto-bar-content">
        <span class="auto-bar-label">
          <span class="auto-pulse"></span>
          ${autoState.paused ? 'En pause' : 'Diffusion auto'} · ${autoState.position + 1}/${autoState.sequence.length}
          ${!autoState.paused ? ` · <span id="autoCountdown">${(autoState.remaining/1000).toFixed(1)}s</span>` : ''}
        </span>
        <div class="auto-bar-controls">
          <button class="btn btn-sm" id="autoPrevBtn" title="Section précédente">⏮</button>
          <button class="btn btn-sm" id="autoPauseBtn">${autoState.paused ? '▶ Reprendre' : '⏸ Pause'}</button>
          <button class="btn btn-sm" id="autoNextBtn" title="Section suivante">⏭</button>
          <button class="btn btn-sm btn-danger" id="autoStopBtn">⏹ Arrêter</button>
        </div>
      </div>
    </div>
  ` : '';

  songsEls.detail.innerHTML = `
    <div class="song-detail-header">
      <div class="song-detail-title-block">
        <div class="song-detail-title">
          ${song.number ? `<span class="song-num-big">${escapeHtml(song.number)}</span>` : ''}
          ${escapeHtml(song.title || '(sans titre)')}
        </div>
        <div class="song-detail-sub">
          ${song.book ? escapeHtml(song.book) : ''}${song.author ? ' · ' + escapeHtml(song.author) : ''}
        </div>
      </div>
      <div class="song-detail-actions">
        <button class="btn btn-sm" id="songEditBtn">✏ Modifier</button>
        <button class="btn btn-sm" id="songDuplicateBtn">⎘ Dupliquer</button>
      </div>
    </div>
    ${!autoState.active ? `
      <div class="auto-controls-row">
        <div class="auto-mode-block">
          <label class="ctrl-label">Mode</label>
          <select id="autoModeSelect" class="input input-sm">
            <option value="adaptive" ${autoState.mode === 'adaptive' ? 'selected' : ''}>Adapté au texte</option>
            <option value="fixed" ${autoState.mode === 'fixed' ? 'selected' : ''}>Durée fixe</option>
          </select>
        </div>
        ${autoState.mode === 'adaptive' ? `
          <div class="auto-speed-block">
            <label class="ctrl-label">Vitesse de lecture</label>
            <div class="speed-slider-wrap">
              <span class="speed-icon">🐢</span>
              <input type="range" id="autoSpeedInput" min="0.5" max="2" step="0.05" value="${autoState.speed}" />
              <span class="speed-icon">🐇</span>
            </div>
            <div class="speed-value" id="autoSpeedValue">${autoState.speed.toFixed(2)}× · ${speedLabel(autoState.speed)}</div>
          </div>
        ` : `
          <div class="auto-duration-block">
            <label class="ctrl-label">Durée par section</label>
            <div class="duration-input-wrap">
              <input type="number" id="autoDurationInput" min="2" max="60" value="${durationSec}" step="1" /> <span>s</span>
            </div>
          </div>
        `}
        <div class="auto-start-block">
          <button class="btn btn-success" id="autoStartBtn" ${sections.length === 0 ? 'disabled' : ''}>▶ Diffuser tout le chant</button>
        </div>
      </div>
    ` : ''}
    ${autoBar}
    <div class="sections-grid">
      ${sections.length === 0 ? '<div class="empty">Ce chant n\'a aucune section. Modifie-le pour en ajouter.</div>' :
        sections.map((sec, i) => {
          const positions = sequencePositions[i] || [];
          const isCurrent = i === stepIdx;
          return `
            <div class="section-card type-${sec.type || 'verse'} ${i === activeSectionIndex ? 'active' : ''} ${isCurrent ? 'now-playing' : ''}" data-i="${i}">
              <div class="section-card-header">
                <span class="section-badge type-${sec.type || 'verse'}">${escapeHtml(sec.label || SECTION_TYPES[sec.type]?.label || 'Section')}</span>
                <div class="section-card-actions">
                  ${positions.length ? `<span class="seq-positions" title="Position(s) dans la séquence">${positions.map(p => `<span class="seq-pos ${p === autoState.position + 1 && autoState.active ? 'current' : ''}">${p}</span>`).join('')}</span>` : ''}
                  <button class="btn btn-sm send-section-btn" data-i="${i}">▶</button>
                </div>
              </div>
              <div class="section-text">${escapeHtml(sec.text || '').replace(/\n/g, '<br>')}</div>
            </div>
          `;
        }).join('')
      }
    </div>
    ${sequence.length > 0 && !autoState.active ? (() => {
      const totalMs = sequence.reduce((sum, idx) => sum + computeStepDuration(sections[idx]), 0);
      const totalStr = totalMs >= 60000 ? `${Math.floor(totalMs/60000)} min ${Math.round((totalMs%60000)/1000)}s` : `${Math.round(totalMs/1000)}s`;
      return `
        <div class="auto-sequence-preview">
          <div class="seq-header">
            <strong>Séquence auto · durée totale ≈ ${totalStr}</strong>
          </div>
          <div class="seq-steps">
            ${sequence.map((idx, p) => {
              const sec = sections[idx];
              const dur = (computeStepDuration(sec) / 1000).toFixed(0);
              return `<span class="seq-step type-${sec.type || 'verse'}">${p + 1}. ${escapeHtml(sec.label || '')} <em>${dur}s</em></span>`;
            }).join(' → ')}
          </div>
        </div>
      `;
    })() : ''}
    <div class="song-help">
      <kbd>←</kbd> / <kbd>→</kbd> naviguer · <kbd>Espace</kbd> diffuser · <kbd>P</kbd> diffuser tout · <kbd>Échap</kbd> arrêter
    </div>
  `;

  // Bind clicks
  songsEls.detail.querySelectorAll('.section-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.send-section-btn')) return;
      const i = parseInt(card.dataset.i);
      activeSectionIndex = i;
      renderSongDetail();
    });
    card.addEventListener('dblclick', () => {
      const i = parseInt(card.dataset.i);
      activeSectionIndex = i;
      sendActiveSection();
    });
  });
  songsEls.detail.querySelectorAll('.send-section-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.i);
      activeSectionIndex = i;
      renderSongDetail();
      sendActiveSection();
    });
  });
  document.getElementById('songEditBtn')?.addEventListener('click', () => openSongEditor(song.id));
  document.getElementById('songDuplicateBtn')?.addEventListener('click', () => duplicateSong(song.id));

  // Auto-play controls
  document.getElementById('autoStartBtn')?.addEventListener('click', startAutoPlay);
  document.getElementById('autoStopBtn')?.addEventListener('click', () => stopAutoPlay());
  document.getElementById('autoPauseBtn')?.addEventListener('click', pauseOrResumeAutoPlay);
  document.getElementById('autoNextBtn')?.addEventListener('click', autoSkipNext);
  document.getElementById('autoPrevBtn')?.addEventListener('click', autoSkipPrev);
  document.getElementById('autoDurationInput')?.addEventListener('change', (e) => {
    setAutoDuration(parseFloat(e.target.value) || 12);
    renderSongDetail();
  });
  document.getElementById('autoModeSelect')?.addEventListener('change', (e) => {
    setAutoMode(e.target.value);
    renderSongDetail();
  });
  const speedInput = document.getElementById('autoSpeedInput');
  if (speedInput) {
    speedInput.addEventListener('input', (e) => {
      setAutoSpeed(e.target.value);
      const lab = document.getElementById('autoSpeedValue');
      if (lab) lab.textContent = `${autoState.speed.toFixed(2)}× · ${speedLabel(autoState.speed)}`;
    });
    speedInput.addEventListener('change', () => {
      renderSongDetail();
    });
  }
}

function sendActiveSection() {
  const song = allSongs.find(s => s.id === activeSongId);
  if (!song) return;
  const sec = (song.sections || [])[activeSectionIndex];
  if (!sec) return;
  pushSongSection(song, activeSectionIndex, sec);
}

// Diffuse la section avec les métadonnées chant complètes : le studio
// (et plus tard les co-pilots) peut afficher un panneau dédié et naviguer
// entre sections sans avoir à connaître la structure du chant.
function pushSongSection(song, sectionIdx, sec) {
  if (typeof broadcastVerse !== 'function') return;
  const sections = song.sections || [];
  const reference = `${song.title}${song.number ? ' (n°' + song.number + ')' : ''} — ${sec.label || ''}`;
  broadcastVerse(reference, sec.text, song.book || 'Chant', {
    kind: 'song',
    songId: song.id,
    songTitle: song.title || '',
    songNumber: song.number || null,
    songBook: song.book || '',
    sectionIndex: sectionIdx,
    totalSections: sections.length,
    sectionLabel: sec.label || '',
    sectionType: sec.type || 'verse',
  });
}

// ============ songNav : pilotage depuis le studio ============
// Le studio envoie { type: 'songNav', action, payload? } via BroadcastChannel.
// Actions :
//   - 'nextSection' / 'prevSection' : navigue dans le chant actif
//   - 'stop' : efface l'écran (clearLive) + stoppe auto-play
//   - 'showByNumber' : payload = numéro (string ou int) → charge ce chant
//   - 'showById' : payload = { songId, sectionIndex? }
try {
  const songsBc = new BroadcastChannel('versetlive');
  songsBc.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'songNav') return;
    handleSongNav(msg.action, msg.payload, songsBc);
  });
} catch (e) {}

function handleSongNav(action, payload, bc) {
  const ack = (ok, reason) => { try { bc && bc.postMessage({ type: 'songNavAck', ok, reason }); } catch (e) {} };

  if (action === 'stop') {
    if (typeof stopAutoPlay === 'function') stopAutoPlay(true);
    if (typeof clearLive === 'function') clearLive();
    return ack(true);
  }

  if (action === 'nextSection' || action === 'prevSection') {
    const song = allSongs.find(s => s.id === activeSongId);
    if (!song) return ack(false, 'no-active-song');
    const sections = song.sections || [];
    if (!sections.length) return ack(false, 'no-sections');
    let next = activeSectionIndex;
    if (action === 'nextSection') {
      if (activeSectionIndex >= sections.length - 1) return ack(false, 'end-of-song');
      next = activeSectionIndex + 1;
    } else {
      if (activeSectionIndex <= 0) return ack(false, 'start-of-song');
      next = activeSectionIndex - 1;
    }
    // Stoppe l'auto-play (navigation manuelle = override)
    if (typeof stopAutoPlay === 'function' && autoState && autoState.active) stopAutoPlay(true);
    activeSectionIndex = next;
    pushSongSection(song, next, sections[next]);
    if (typeof renderSongDetail === 'function') renderSongDetail();
    return ack(true);
  }

  if (action === 'showByNumber') {
    const num = String(payload || '').trim();
    if (!num) return ack(false, 'parse');
    const song = allSongs.find(s => String(s.number || '') === num);
    if (!song) return ack(false, 'song-not-found');
    activeSongId = song.id;
    activeSectionIndex = 0;
    const sec = (song.sections || [])[0];
    if (sec) pushSongSection(song, 0, sec);
    if (typeof renderSongDetail === 'function') renderSongDetail();
    return ack(true);
  }

  if (action === 'showById' && payload && payload.songId) {
    const song = allSongs.find(s => s.id === payload.songId);
    if (!song) return ack(false, 'song-not-found');
    activeSongId = song.id;
    activeSectionIndex = Number.isInteger(payload.sectionIndex) ? payload.sectionIndex : 0;
    const sec = (song.sections || [])[activeSectionIndex];
    if (sec) pushSongSection(song, activeSectionIndex, sec);
    if (typeof renderSongDetail === 'function') renderSongDetail();
    return ack(true);
  }

  ack(false, 'unknown-action');
}

// ====== EDITOR MODAL ======
function openSongEditor(id) {
  editingSongId = id;
  const song = id ? allSongs.find(s => s.id === id) : null;
  songsEls.modalTitle.textContent = song ? 'Modifier le chant' : 'Nouveau chant';
  songsEls.fNumber.value = song?.number || '';
  songsEls.fTitle.value = song?.title || '';
  songsEls.fAuthor.value = song?.author || '';
  // Populate book dropdown
  songsEls.fBook.innerHTML = SONG_BOOKS.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  const defaultBook = activeSongTab() === 'louange' ? 'Chants de Louange' : 'Chants de Victoire';
  songsEls.fBook.value = song?.book || defaultBook;

  renderEditorSections(song?.sections ? JSON.parse(JSON.stringify(song.sections)) : []);
  songsEls.deleteBtn.hidden = !song;
  songsEls.modal.classList.add('show');
  setTimeout(() => songsEls.fTitle.focus(), 50);
}

function closeSongEditor() {
  songsEls.modal.classList.remove('show');
  editingSongId = null;
}

let editorSections = [];
function renderEditorSections(sections) {
  editorSections = sections;
  songsEls.sectionsList.innerHTML = sections.map((sec, i) => `
    <div class="editor-section type-${sec.type || 'verse'}" data-i="${i}">
      <div class="editor-section-header">
        <select class="input editor-type" data-i="${i}">
          <option value="verse" ${sec.type === 'verse' ? 'selected' : ''}>Couplet</option>
          <option value="chorus" ${sec.type === 'chorus' ? 'selected' : ''}>Refrain</option>
          <option value="bridge" ${sec.type === 'bridge' ? 'selected' : ''}>Pont</option>
          <option value="prechorus" ${sec.type === 'prechorus' ? 'selected' : ''}>Pré-refrain</option>
          <option value="ending" ${sec.type === 'ending' ? 'selected' : ''}>Final</option>
        </select>
        <input type="text" class="input editor-label" data-i="${i}" value="${escapeHtml(sec.label || '')}" placeholder="Étiquette (ex: Couplet 1)" />
        <div class="editor-section-actions">
          <button class="btn btn-sm" data-action="up" data-i="${i}" title="Monter">▲</button>
          <button class="btn btn-sm" data-action="down" data-i="${i}" title="Descendre">▼</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-i="${i}" title="Supprimer">✕</button>
        </div>
      </div>
      <textarea class="input editor-text" data-i="${i}" rows="5" placeholder="Paroles de la section…">${escapeHtml(sec.text || '')}</textarea>
    </div>
  `).join('');

  // Wire events
  songsEls.sectionsList.querySelectorAll('.editor-type').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = parseInt(sel.dataset.i);
      editorSections[i].type = sel.value;
      const auto = SECTION_TYPES[sel.value]?.label;
      const labelInput = songsEls.sectionsList.querySelector(`.editor-label[data-i="${i}"]`);
      if (labelInput && (!labelInput.value || Object.values(SECTION_TYPES).some(t => labelInput.value.startsWith(t.label)))) {
        labelInput.value = auto + ' ' + (countOfType(sel.value, i) || '');
        labelInput.value = labelInput.value.trim();
        editorSections[i].label = labelInput.value;
      }
      renderEditorSections(editorSections);
    });
  });
  songsEls.sectionsList.querySelectorAll('.editor-label').forEach(inp => {
    inp.addEventListener('input', () => {
      editorSections[parseInt(inp.dataset.i)].label = inp.value;
    });
  });
  songsEls.sectionsList.querySelectorAll('.editor-text').forEach(t => {
    t.addEventListener('input', () => {
      editorSections[parseInt(t.dataset.i)].text = t.value;
    });
  });
  songsEls.sectionsList.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.i);
      const action = btn.dataset.action;
      if (action === 'up' && i > 0) {
        [editorSections[i - 1], editorSections[i]] = [editorSections[i], editorSections[i - 1]];
      } else if (action === 'down' && i < editorSections.length - 1) {
        [editorSections[i + 1], editorSections[i]] = [editorSections[i], editorSections[i + 1]];
      } else if (action === 'delete') {
        editorSections.splice(i, 1);
      }
      renderEditorSections(editorSections);
    });
  });
}

function countOfType(type, beforeIndex) {
  let n = 0;
  for (let i = 0; i <= beforeIndex; i++) {
    if (editorSections[i]?.type === type) n++;
  }
  return n;
}

function addSection(type) {
  const count = editorSections.filter(s => s.type === type).length + 1;
  const baseLabel = SECTION_TYPES[type]?.label || 'Section';
  const label = type === 'chorus' && count === 1 ? 'Refrain' : `${baseLabel} ${count}`;
  editorSections.push({ type, label, text: '' });
  renderEditorSections(editorSections);
  // Focus the new textarea
  setTimeout(() => {
    const last = songsEls.sectionsList.querySelector(`.editor-text[data-i="${editorSections.length - 1}"]`);
    last?.focus();
  }, 50);
}

function saveSongFromEditor() {
  const title = songsEls.fTitle.value.trim();
  if (!title) {
    alert('Saisissez au moins un titre');
    songsEls.fTitle.focus();
    return;
  }
  const cleanSections = editorSections
    .map(s => ({
      type: s.type || 'verse',
      label: (s.label || '').trim() || SECTION_TYPES[s.type || 'verse'].label,
      text: (s.text || '').trim(),
    }))
    .filter(s => s.text);

  const data = {
    id: editingSongId || generateSongId(),
    number: songsEls.fNumber.value.trim(),
    title,
    author: songsEls.fAuthor.value.trim(),
    book: songsEls.fBook.value,
    sections: cleanSections,
  };
  if (editingSongId) {
    const idx = allSongs.findIndex(s => s.id === editingSongId);
    if (idx >= 0) allSongs[idx] = data;
    else allSongs.push(data);
  } else {
    allSongs.push(data);
  }
  saveSongs(allSongs);
  activeSongId = data.id;
  closeSongEditor();
  renderSongsList();
  renderSongDetail();
  if (typeof toast === 'function') toast('Chant enregistré : ' + data.title);
}

function deleteCurrentSong() {
  if (!editingSongId) return;
  const song = allSongs.find(s => s.id === editingSongId);
  if (!song) return;
  if (!confirm(`Supprimer "${song.title}" ?`)) return;
  allSongs = allSongs.filter(s => s.id !== editingSongId);
  saveSongs(allSongs);
  if (activeSongId === editingSongId) activeSongId = null;
  closeSongEditor();
  renderSongsList();
  renderSongDetail();
  if (typeof toast === 'function') toast('Chant supprimé');
}

function duplicateSong(id) {
  const song = allSongs.find(s => s.id === id);
  if (!song) return;
  const copy = JSON.parse(JSON.stringify(song));
  copy.id = generateSongId();
  copy.title = song.title + ' (copie)';
  copy.number = '';
  allSongs.push(copy);
  saveSongs(allSongs);
  activeSongId = copy.id;
  renderSongsList();
  renderSongDetail();
  if (typeof toast === 'function') toast('Chant dupliqué');
}

// ====== IMPORT / EXPORT ======
function exportSongs(louangeOnly) {
  const list = louangeOnly ? allSongs.filter(isLouangeSong) : allSongs;
  const data = {
    version: SONGS_VERSION,
    exportedAt: new Date().toISOString(),
    kind: louangeOnly ? 'louange' : 'all',
    songs: list,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const prefix = louangeOnly ? 'louange' : 'chants';
  a.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  if (typeof toast === 'function') toast(`${list.length} chant(s) exporté(s)`);
}

function importSongs(file, forceLouange) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      let imported = [];
      if (Array.isArray(data)) imported = data;
      else if (Array.isArray(data.songs)) imported = data.songs;
      else throw new Error('Format JSON inattendu');

      const merge = confirm(
        `Importer ${imported.length} chant(s).\n\n` +
        `OK = Fusionner avec les chants actuels (${allSongs.length})\n` +
        `Annuler = Remplacer complètement les chants actuels`
      );

      const defaultBook = forceLouange ? 'Chants de Louange' : 'Chants de Victoire';
      const normalize = (s) => ({
        id: s.id || generateSongId(),
        number: s.number || '',
        title: s.title || '(sans titre)',
        author: s.author || '',
        book: forceLouange ? (LOUANGE_BOOKS.includes(s.book) ? s.book : 'Chants de Louange') : (s.book || defaultBook),
        sections: Array.isArray(s.sections) ? s.sections.map(sec => ({
          type: sec.type || 'verse',
          label: sec.label || SECTION_TYPES[sec.type]?.label || 'Section',
          text: sec.text || '',
        })) : [],
      });

      if (merge) {
        const existingIds = new Set(allSongs.map(s => s.id));
        imported.forEach(s => {
          const norm = normalize(s);
          if (existingIds.has(norm.id)) norm.id = generateSongId();
          allSongs.push(norm);
        });
      } else {
        allSongs = imported.map(normalize);
      }
      saveSongs(allSongs);
      renderSongsList();
      if (typeof toast === 'function') toast(`Import OK — ${allSongs.length} chants au total`);
    } catch (err) {
      alert('Erreur d\'import : ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ====== EVENT BINDINGS ======
function initSongs() {
  if (!songsEls.list) return; // Pas de panneau chants dans cette page

  songsEls.search.addEventListener('input', renderSongsList);
  songsEls.newBtn.addEventListener('click', () => openSongEditor(null));
  songsEls.importBtn.addEventListener('click', () => songsEls.importFile.click());
  songsEls.exportBtn.addEventListener('click', () => exportSongs(false));

  // Onglet Louange (chants modernes)
  songsEls.louangeSearch?.addEventListener('input', renderSongsList);
  songsEls.louangeNewBtn?.addEventListener('click', () => openSongEditor(null));
  songsEls.louangeImportBtn?.addEventListener('click', () => songsEls.louangeImportFile.click());
  songsEls.louangeExportBtn?.addEventListener('click', () => exportSongs(true));
  songsEls.louangeImportFile?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importSongs(file, true);
    e.target.value = '';
  });

  // Recharger le recueil 1926 (308 chants du domaine public)
  document.getElementById('loadCatalogBtn')?.addEventListener('click', () => {
    if (typeof CHANTS_VICTOIRE_1926 === 'undefined' || !CHANTS_VICTOIRE_1926.length) {
      alert('Catalogue indisponible (chants-cv-data.js non chargé)');
      return;
    }
    const userSongs = allSongs.filter(s => !s.id || !s.id.startsWith('cv-1926-'));
    const choice = confirm(
      `Recharger les ${CHANTS_VICTOIRE_1926.length} chants du recueil 1926 (domaine public).\n\n` +
      `OK = Fusionner avec tes chants personnels (${userSongs.length} conservés)\n` +
      `Annuler = Garder uniquement le recueil 1926 (tes chants seront supprimés)`
    );
    if (choice) {
      // Fusion : garde les chants persos + ajoute le catalogue
      allSongs = [...userSongs, ...JSON.parse(JSON.stringify(CHANTS_VICTOIRE_1926))];
    } else {
      // Remplacement complet
      allSongs = JSON.parse(JSON.stringify(CHANTS_VICTOIRE_1926));
    }
    saveSongs(allSongs);
    renderSongsList();
    if (typeof toast === 'function') toast(`Recueil 1926 chargé — ${allSongs.length} chants au total`);
  });
  songsEls.importFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importSongs(file);
    e.target.value = '';
  });

  songsEls.modalClose.addEventListener('click', closeSongEditor);
  songsEls.cancelBtn.addEventListener('click', closeSongEditor);
  songsEls.saveBtn.addEventListener('click', saveSongFromEditor);
  songsEls.deleteBtn.addEventListener('click', deleteCurrentSong);
  songsEls.addVerseBtn.addEventListener('click', () => addSection('verse'));
  songsEls.addChorusBtn.addEventListener('click', () => addSection('chorus'));
  songsEls.addBridgeBtn.addEventListener('click', () => addSection('bridge'));
  songsEls.modal.addEventListener('click', (e) => {
    if (e.target === songsEls.modal) closeSongEditor();
  });

  // Keyboard navigation when on Songs tab
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (songsEls.modal.classList.contains('show')) return;
    const songsTabActive = document.querySelector('.tab.active')?.dataset.tab === 'songs';
    if (!songsTabActive) return;
    const song = allSongs.find(s => s.id === activeSongId);
    if (!song || !song.sections?.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      activeSectionIndex = Math.min(activeSectionIndex + 1, song.sections.length - 1);
      renderSongDetail();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      activeSectionIndex = Math.max(activeSectionIndex - 1, 0);
      renderSongDetail();
      e.preventDefault();
    } else if (e.key === ' ' || e.key === 'Enter') {
      if (activeSectionIndex < 0) activeSectionIndex = 0;
      sendActiveSection();
      renderSongDetail();
      e.preventDefault();
    } else if (e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      if (idx < song.sections.length) {
        activeSectionIndex = idx;
        sendActiveSection();
        renderSongDetail();
      }
    } else if (e.key === 'p' || e.key === 'P') {
      if (autoState.active) stopAutoPlay();
      else startAutoPlay();
      e.preventDefault();
    }
  });

  renderSongsList();
  renderSongDetail();
}

initSongs();
