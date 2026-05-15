// Contrôle OBS Studio via obs-websocket v5
// Protocole : https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

const OBS_SETTINGS_KEY = 'versetlive:obs-settings';
const OBS_UI_KEY = 'versetlive:obs-ui';

const OP = {
  HELLO: 0,
  IDENTIFY: 1,
  IDENTIFIED: 2,
  REIDENTIFY: 3,
  EVENT: 5,
  REQUEST: 6,
  REQUEST_RESPONSE: 7,
};

// eventSubscriptions : standard (2047) sans vu-mètres ; les InputVolumeMeters (65536)
// sont abonnés à la demande (uniquement quand la section Mixeur est dépliée)
// pour limiter le trafic WebSocket et la charge OBS pendant les diffusions.
const SUB_BASE = 2047;
const SUB_AUDIO_METERS = 65536;

class ObsClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.identified = false;
    this.pending = new Map();
    this.reqCounter = 0;
    this.url = null;
    this.password = null;
    this.shouldReconnect = false;
    this.reconnectTimer = null;
  }

  get state() {
    if (this.identified) return 'connected';
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
    if (this.connected) return 'authenticating';
    return 'disconnected';
  }

  async connect(host, port, password) {
    this.disconnect();
    this.url = `ws://${host}:${port}`;
    this.password = password || '';
    this.shouldReconnect = true;
    return this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(); else reject(err);
      };

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) { finish(false, err); return; }

      this.ws.addEventListener('open', () => {
        this.connected = true;
        this._emit('state-change');
      });

      this.ws.addEventListener('message', async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        const { op, d } = msg;
        if (op === OP.HELLO) {
          try { await this._handleHello(d); }
          catch (err) { finish(false, err); this.disconnect(false); }
        } else if (op === OP.IDENTIFIED) {
          this.identified = true;
          this._emit('state-change');
          this._emit('connected');
          finish(true);
        } else if (op === OP.EVENT) {
          this._emit('obs-event', { type: d.eventType, data: d.eventData });
        } else if (op === OP.REQUEST_RESPONSE) {
          const p = this.pending.get(d.requestId);
          if (!p) return;
          this.pending.delete(d.requestId);
          if (d.requestStatus && d.requestStatus.result) p.resolve(d.responseData || {});
          else p.reject(new Error((d.requestStatus && d.requestStatus.comment) || 'OBS request failed'));
        }
      });

      this.ws.addEventListener('close', (event) => {
        const wasIdentified = this.identified;
        this.connected = false;
        this.identified = false;
        this._failAllPending(new Error('Connexion fermée'));
        this._emit('state-change');
        this._emit('disconnected', { code: event.code, reason: event.reason });
        finish(false, new Error(`Connexion fermée (code ${event.code})`));
        if (this.shouldReconnect && wasIdentified) this._scheduleReconnect();
      });

      this.ws.addEventListener('error', () => {
        finish(false, new Error('Erreur WebSocket — OBS est-il lancé et le serveur WebSocket activé ?'));
      });
    });
  }

  async _handleHello(d) {
    const identifyMsg = {
      op: OP.IDENTIFY,
      d: { rpcVersion: d.rpcVersion, eventSubscriptions: SUB_BASE },
    };
    if (d.authentication) {
      if (!this.password) throw new Error('OBS demande un mot de passe mais aucun n\'est configuré');
      identifyMsg.d.authentication = await this._authString(this.password, d.authentication.salt, d.authentication.challenge);
    }
    this.ws.send(JSON.stringify(identifyMsg));
  }

  reidentify(eventSubscriptions) {
    if (!this.identified || !this.ws) return;
    this.ws.send(JSON.stringify({ op: OP.REIDENTIFY, d: { eventSubscriptions } }));
  }

  async _authString(password, salt, challenge) {
    const secret = await sha256Base64(password + salt);
    return await sha256Base64(secret + challenge);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      this._emit('reconnecting');
      this._open().catch(() => { if (this.shouldReconnect) this._scheduleReconnect(); });
    }, 3000);
  }

  disconnect(userInitiated = true) {
    if (userInitiated) this.shouldReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
    this.identified = false;
    this._failAllPending(new Error('Déconnecté'));
    this._emit('state-change');
  }

  _failAllPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  request(requestType, requestData) {
    if (!this.identified) return Promise.reject(new Error('Non connecté à OBS'));
    const requestId = String(++this.reqCounter);
    const msg = { op: OP.REQUEST, d: { requestType, requestId, requestData: requestData || {} } };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`Timeout sur ${requestType}`));
        }
      }, 10000);
    });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

async function sha256Base64(str) {
  const enc = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  let bin = '';
  const bytes = new Uint8Array(hash);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// =================================================================
// État UI
// =================================================================

const obs = new ObsClient();
let obsScenes = [];
let obsCurrentScene = null;
let obsPreviewScene = null;
let obsStudioMode = false;
let obsAudioInputs = []; // [{name, muted, volumeDb}]
let obsSceneItems = []; // pour la scène active
let obsReplayActive = false;
let obsRecordPaused = false;
let obsTransitions = [];
let obsCurrentTransition = null;
let obsTransitionDuration = 300;
let obsStatusTimer = null;
let obsStatsTimer = null;
let obsPreviewTimer = null;
let obsPreviewFps = 2;
let obsPreviewInFlight = false;
let lastVolumeMetersAt = 0;

// =================================================================
// Utils
// =================================================================

function fmtDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmtBitrate(bytesPerSec) {
  if (!bytesPerSec) return '— kb/s';
  const kbps = (bytesPerSec * 8) / 1000;
  if (kbps > 1000) return (kbps / 1000).toFixed(1) + ' Mb/s';
  return Math.round(kbps) + ' kb/s';
}

function obsToast(msg, isError) {
  const t = document.getElementById('toast');
  if (!t) { console.log(msg); return; }
  t.textContent = msg;
  t.style.background = isError ? 'var(--danger)' : 'var(--success)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function loadObsSettings() {
  try {
    const raw = localStorage.getItem(OBS_SETTINGS_KEY);
    if (!raw) return { host: 'localhost', port: 4455, password: '', autoConnect: false };
    const s = JSON.parse(raw);
    return { host: s.host || 'localhost', port: s.port || 4455, password: s.password || '', autoConnect: !!s.autoConnect };
  } catch {
    return { host: 'localhost', port: 4455, password: '', autoConnect: false };
  }
}

function saveObsSettings(settings) {
  localStorage.setItem(OBS_SETTINGS_KEY, JSON.stringify(settings));
}

function loadUiState() {
  try { return JSON.parse(localStorage.getItem(OBS_UI_KEY) || '{}'); }
  catch { return {}; }
}

function saveUiState(state) {
  localStorage.setItem(OBS_UI_KEY, JSON.stringify(state));
}

// =================================================================
// Sections collapsibles
// =================================================================

function bindCollapsibles() {
  const ui = loadUiState();
  const collapsed = ui.collapsed || {};
  document.querySelectorAll('.obs-sub').forEach(sub => {
    const key = sub.dataset.key;
    if (collapsed[key]) sub.classList.add('collapsed');
    const head = sub.querySelector('.obs-sub-head');
    head.addEventListener('click', () => {
      sub.classList.toggle('collapsed');
      const state = loadUiState();
      state.collapsed = state.collapsed || {};
      state.collapsed[key] = sub.classList.contains('collapsed');
      saveUiState(state);
      if (key === 'audio') syncAudioMetersSubscription();
    });
  });
}

function isAudioSectionVisible() {
  const sub = document.querySelector('.obs-sub[data-key="audio"]');
  return !!(sub && !sub.classList.contains('collapsed'));
}

function syncAudioMetersSubscription() {
  if (obs.state !== 'connected') return;
  const want = SUB_BASE | (isAudioSectionVisible() ? SUB_AUDIO_METERS : 0);
  obs.reidentify(want);
}

// =================================================================
// Connexion
// =================================================================

function updateObsConnState() {
  const dot = document.getElementById('obsConnDot');
  const label = document.getElementById('obsConnLabel');
  const panel = document.getElementById('obsPanelContent');
  const connectBtn = document.getElementById('obsConnectBtn');
  if (!dot) return;
  const state = obs.state;
  dot.className = 'obs-conn-dot ' + state;
  const labels = { connected: 'Connecté', authenticating: 'Authentification…', connecting: 'Connexion…', disconnected: 'Déconnecté' };
  label.textContent = labels[state] || state;
  panel.classList.toggle('disabled', state !== 'connected');
  connectBtn.textContent = state === 'connected' ? '⏏ Déconnecter' : '🔌 Connecter';
}

async function connectObs() {
  const s = loadObsSettings();
  if (obs.state === 'connected') { obs.disconnect(); return; }
  try {
    await obs.connect(s.host, s.port, s.password);
    obsToast('Connecté à OBS');
    await initialFetch();
    syncAudioMetersSubscription();
    startStatusPolling();
    startStatsPolling();
    startPreviewPolling();
  } catch (err) {
    obsToast(err.message, true);
  }
}

async function initialFetch() {
  await refreshScenes();
  await refreshStudioMode();
  await refreshTransitions();
  await refreshAudioInputs();
  await refreshSceneItems();
  await refreshReplayStatus();
  await refreshStreamStatus();
}

// =================================================================
// Scènes + studio mode
// =================================================================

async function refreshScenes() {
  try {
    const res = await obs.request('GetSceneList');
    obsCurrentScene = res.currentProgramSceneName;
    obsPreviewScene = res.currentPreviewSceneName || null;
    obsScenes = (res.scenes || []).slice().reverse();
    renderScenes();
  } catch {}
}

function renderScenes() {
  renderSceneList('obsScenesList', obsCurrentScene, async (name) => {
    try { await obs.request('SetCurrentProgramScene', { sceneName: name }); }
    catch (err) { obsToast('Échec : ' + err.message, true); }
  });
  renderSceneList('obsPreviewList', obsPreviewScene, async (name) => {
    try { await obs.request('SetCurrentPreviewScene', { sceneName: name }); }
    catch (err) { obsToast('Échec : ' + err.message, true); }
  });
  // toggle preview wrap visibility
  document.getElementById('obsPreviewWrap').style.display = obsStudioMode ? 'block' : 'none';
}

function renderSceneList(elementId, activeName, onClick) {
  const list = document.getElementById(elementId);
  if (!list) return;
  list.innerHTML = '';
  if (!obsScenes.length) {
    list.innerHTML = '<div class="obs-empty">Aucune scène</div>';
    return;
  }
  obsScenes.forEach((scene, idx) => {
    const btn = document.createElement('button');
    btn.className = 'obs-scene-btn' + (scene.sceneName === activeName ? ' active' : '');
    const numHint = idx < 9 ? `<span class="obs-scene-key">${idx + 1}</span>` : '';
    btn.innerHTML = numHint + '<span>' + escapeHtml(scene.sceneName) + '</span>';
    btn.addEventListener('click', () => onClick(scene.sceneName));
    list.appendChild(btn);
  });
}

async function refreshStudioMode() {
  try {
    const res = await obs.request('GetStudioModeEnabled');
    obsStudioMode = !!res.studioModeEnabled;
    document.getElementById('obsStudioMode').checked = obsStudioMode;
    document.getElementById('obsPreviewWrap').style.display = obsStudioMode ? 'block' : 'none';
    updatePreviewThumbsVisibility();
  } catch {}
}

async function toggleStudioMode(enabled) {
  try {
    await obs.request('SetStudioModeEnabled', { studioModeEnabled: enabled });
    obsStudioMode = enabled;
    document.getElementById('obsPreviewWrap').style.display = enabled ? 'block' : 'none';
    updatePreviewThumbsVisibility();
    if (enabled) await refreshScenes();
  } catch (err) { obsToast(err.message, true); }
}

async function refreshTransitions() {
  try {
    const list = await obs.request('GetSceneTransitionList');
    obsTransitions = list.transitions || [];
    const cur = await obs.request('GetCurrentSceneTransition');
    obsCurrentTransition = cur.transitionName;
    obsTransitionDuration = cur.transitionDuration || 300;

    const sel = document.getElementById('obsTransitionType');
    sel.innerHTML = '';
    obsTransitions.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.transitionName;
      opt.textContent = t.transitionName;
      if (t.transitionName === obsCurrentTransition) opt.selected = true;
      sel.appendChild(opt);
    });

    const slider = document.getElementById('obsTransitionDuration');
    slider.value = obsTransitionDuration;
    document.getElementById('obsTransitionDurationVal').textContent = obsTransitionDuration + ' ms';
  } catch {}
}

async function triggerTransition() {
  try {
    if (obsStudioMode) await obs.request('TriggerStudioModeTransition');
    else obsToast('Active d\'abord le mode studio', true);
  } catch (err) { obsToast(err.message, true); }
}

// =================================================================
// Mixeur audio
// =================================================================

async function refreshAudioInputs() {
  try {
    const res = await obs.request('GetInputList');
    const inputs = res.inputs || [];
    // Filtrer ceux qui supportent l'audio (en testant GetInputMute)
    const audio = [];
    await Promise.all(inputs.map(async (inp) => {
      try {
        const mute = await obs.request('GetInputMute', { inputName: inp.inputName });
        const vol = await obs.request('GetInputVolume', { inputName: inp.inputName });
        audio.push({
          name: inp.inputName,
          muted: !!mute.inputMuted,
          volumeDb: vol.inputVolumeDb,
          level: 0,
        });
      } catch {} // pas une entrée audio
    }));
    audio.sort((a, b) => a.name.localeCompare(b.name));
    obsAudioInputs = audio;
    renderMixer();
  } catch {}
}

function renderMixer() {
  const el = document.getElementById('obsMixer');
  if (!el) return;
  el.innerHTML = '';
  if (!obsAudioInputs.length) {
    el.innerHTML = '<div class="obs-empty">Aucune source audio</div>';
    return;
  }
  obsAudioInputs.forEach(inp => {
    const row = document.createElement('div');
    row.className = 'obs-audio-row' + (inp.muted ? ' muted' : '');
    row.dataset.name = inp.name;

    const muteBtn = document.createElement('button');
    muteBtn.className = 'obs-audio-mute';
    muteBtn.textContent = inp.muted ? '🔇' : '🔊';
    muteBtn.title = inp.muted ? 'Réactiver' : 'Mute';
    muteBtn.addEventListener('click', async () => {
      try {
        await obs.request('ToggleInputMute', { inputName: inp.name });
      } catch (err) { obsToast(err.message, true); }
    });

    const label = document.createElement('div');
    label.className = 'obs-audio-label';
    label.textContent = inp.name;

    const meter = document.createElement('div');
    meter.className = 'obs-audio-meter';
    meter.innerHTML = '<div class="obs-audio-meter-fill" data-meter></div>';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = -60;
    slider.max = 0;
    slider.step = 0.1;
    slider.value = Math.max(-60, Math.min(0, inp.volumeDb));
    slider.className = 'obs-audio-slider';
    slider.addEventListener('input', async () => {
      const db = parseFloat(slider.value);
      inp.volumeDb = db;
      try { await obs.request('SetInputVolume', { inputName: inp.name, inputVolumeDb: db }); }
      catch (err) { obsToast(err.message, true); }
    });

    const dbLabel = document.createElement('div');
    dbLabel.className = 'obs-audio-db';
    dbLabel.textContent = formatDb(inp.volumeDb);
    slider.addEventListener('input', () => { dbLabel.textContent = formatDb(parseFloat(slider.value)); });

    row.append(muteBtn, label, meter, slider, dbLabel);
    el.appendChild(row);
  });
}

function formatDb(db) {
  if (db <= -60) return '−∞';
  return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
}

function applyVolumeMeters(inputs) {
  // Throttle DOM updates
  const now = performance.now();
  if (now - lastVolumeMetersAt < 60) return;
  lastVolumeMetersAt = now;

  const rows = document.querySelectorAll('.obs-audio-row');
  rows.forEach(row => {
    const name = row.dataset.name;
    const entry = inputs.find(i => i.inputName === name);
    const fill = row.querySelector('[data-meter]');
    if (!fill) return;
    if (!entry || !entry.inputLevelsMul || !entry.inputLevelsMul.length) {
      fill.style.width = '0%';
      return;
    }
    // peak du premier canal
    const channel = entry.inputLevelsMul[0];
    const peak = channel ? (channel[1] || 0) : 0;
    const pct = Math.min(100, Math.max(0, peak * 100));
    fill.style.width = pct + '%';
    fill.style.background = pct > 85 ? 'var(--danger)' : (pct > 65 ? '#f59e0b' : 'var(--success)');
  });
}

async function toggleMasterMute() {
  if (!obsAudioInputs.length) return;
  const anyUnmuted = obsAudioInputs.some(i => !i.muted);
  await Promise.all(obsAudioInputs.map(i =>
    obs.request('SetInputMute', { inputName: i.name, inputMuted: anyUnmuted }).catch(() => {})
  ));
  obsToast(anyUnmuted ? 'Tout mute' : 'Tout unmute');
}

// =================================================================
// Sources visibles de la scène
// =================================================================

async function refreshSceneItems() {
  if (!obsCurrentScene) { obsSceneItems = []; renderSources(); return; }
  try {
    const res = await obs.request('GetSceneItemList', { sceneName: obsCurrentScene });
    obsSceneItems = (res.sceneItems || []).slice().reverse(); // ordre visible
    renderSources();
  } catch { obsSceneItems = []; renderSources(); }
}

function renderSources() {
  const el = document.getElementById('obsSources');
  if (!el) return;
  el.innerHTML = '';
  if (!obsSceneItems.length) {
    el.innerHTML = '<div class="obs-empty">—</div>';
    return;
  }
  obsSceneItems.forEach(item => {
    const row = document.createElement('div');
    row.className = 'obs-source-row';
    const eye = document.createElement('button');
    eye.className = 'obs-source-eye' + (item.sceneItemEnabled ? ' on' : '');
    eye.textContent = item.sceneItemEnabled ? '👁' : '🚫';
    eye.title = item.sceneItemEnabled ? 'Masquer' : 'Afficher';
    eye.addEventListener('click', async () => {
      try {
        await obs.request('SetSceneItemEnabled', {
          sceneName: obsCurrentScene,
          sceneItemId: item.sceneItemId,
          sceneItemEnabled: !item.sceneItemEnabled,
        });
        item.sceneItemEnabled = !item.sceneItemEnabled;
        renderSources();
      } catch (err) { obsToast(err.message, true); }
    });
    const label = document.createElement('div');
    label.className = 'obs-source-label';
    label.textContent = item.sourceName;
    row.append(eye, label);
    el.appendChild(row);
  });
}

// =================================================================
// Diffusion : stream, record, replay
// =================================================================

async function refreshStreamStatus() {
  try {
    const [stream, record] = await Promise.all([
      obs.request('GetStreamStatus'),
      obs.request('GetRecordStatus'),
    ]);

    const streamBtn = document.getElementById('obsStreamBtn');
    const streamInfo = document.getElementById('obsStreamInfo');
    streamBtn.classList.toggle('active', stream.outputActive);
    streamBtn.innerHTML = stream.outputActive ? '⏹ Arrêter le stream' : '▶ Démarrer le stream';
    if (stream.outputActive) {
      const seconds = (stream.outputDuration || 0) / 1000;
      const avgBytes = seconds > 0 ? stream.outputBytes / seconds : 0;
      streamInfo.textContent = `⏱ ${fmtDuration(stream.outputDuration)} · ${fmtBitrate(avgBytes)} · skipped ${stream.outputSkippedFrames || 0}`;
      streamInfo.style.display = 'block';
    } else streamInfo.style.display = 'none';

    const recordBtn = document.getElementById('obsRecordBtn');
    const recordPause = document.getElementById('obsRecordPauseBtn');
    const recordInfo = document.getElementById('obsRecordInfo');
    recordBtn.classList.toggle('active', record.outputActive);
    recordBtn.innerHTML = record.outputActive ? '⏹ Arrêter l\'enreg.' : '⏺ Démarrer l\'enreg.';
    obsRecordPaused = !!record.outputPaused;
    recordPause.style.display = record.outputActive ? 'inline-flex' : 'none';
    recordPause.textContent = obsRecordPaused ? '▶' : '⏸';
    recordPause.title = obsRecordPaused ? 'Reprendre' : 'Pause';
    if (record.outputActive) {
      recordInfo.textContent = `⏱ ${fmtDuration(record.outputDuration)}${obsRecordPaused ? ' · ⏸ pause' : ''}`;
      recordInfo.style.display = 'block';
    } else recordInfo.style.display = 'none';
  } catch {}
}

async function refreshReplayStatus() {
  try {
    const res = await obs.request('GetReplayBufferStatus');
    obsReplayActive = !!res.outputActive;
    const btn = document.getElementById('obsReplayToggleBtn');
    const save = document.getElementById('obsReplaySaveBtn');
    const info = document.getElementById('obsReplayInfo');
    btn.textContent = obsReplayActive ? '⏹ Arrêter' : '▶ Démarrer';
    btn.classList.toggle('active', obsReplayActive);
    save.disabled = !obsReplayActive;
    info.style.display = obsReplayActive ? 'block' : 'none';
  } catch {}
}

function startStatusPolling() {
  stopStatusPolling();
  refreshStreamStatus();
  obsStatusTimer = setInterval(refreshStreamStatus, 3000);
}
function stopStatusPolling() {
  if (obsStatusTimer) { clearInterval(obsStatusTimer); obsStatusTimer = null; }
}

// =================================================================
// Stats
// =================================================================

async function refreshStats() {
  try {
    const stats = await obs.request('GetStats');
    const el = document.getElementById('obsStats');
    if (!el) return;
    const cpu = (stats.cpuUsage || 0).toFixed(1);
    const fps = (stats.activeFps || 0).toFixed(1);
    const dropped = (stats.outputSkippedFrames || 0) + ' / ' + (stats.outputTotalFrames || 0);
    const renderSkipped = stats.renderSkippedFrames || 0;
    const cpuClass = stats.cpuUsage > 80 ? 'crit' : (stats.cpuUsage > 50 ? 'warn' : '');
    const fpsClass = stats.activeFps < 25 ? 'crit' : (stats.activeFps < 28 ? 'warn' : '');
    el.innerHTML = `
      <div class="obs-stat ${cpuClass}"><span>CPU OBS</span><strong>${cpu}%</strong></div>
      <div class="obs-stat ${fpsClass}"><span>FPS</span><strong>${fps}</strong></div>
      <div class="obs-stat"><span>Frames sortie</span><strong>${dropped}</strong></div>
      <div class="obs-stat"><span>Frames rendu skip.</span><strong>${renderSkipped}</strong></div>
    `;
  } catch {}
}

function startStatsPolling() {
  stopStatsPolling();
  refreshStats();
  obsStatsTimer = setInterval(refreshStats, 4000);
}
function stopStatsPolling() {
  if (obsStatsTimer) { clearInterval(obsStatsTimer); obsStatsTimer = null; }
}

// =================================================================
// Aperçu live (miniatures Program / Preview via GetSourceScreenshot)
// =================================================================

function isPreviewSectionCollapsed() {
  const sub = document.querySelector('.obs-sub[data-key="preview"]');
  return !!(sub && sub.classList.contains('collapsed'));
}

async function captureThumb(sceneName, imgEl, thumbEl) {
  if (!sceneName || !imgEl) return;
  try {
    const baseWidth = Math.max(160, imgEl.clientWidth || thumbEl?.clientWidth || 240);
    const targetWidth = Math.max(160, Math.min(640, Math.round(baseWidth * (window.devicePixelRatio || 1))));
    const res = await obs.request('GetSourceScreenshot', {
      sourceName: sceneName,
      imageFormat: 'jpg',
      imageWidth: targetWidth,
      imageCompressionQuality: 60,
    });
    if (res && res.imageData) {
      imgEl.src = res.imageData;
      if (thumbEl) {
        thumbEl.classList.add('has-img');
        thumbEl.dataset.err = '';
      }
    }
  } catch (err) {
    if (thumbEl) thumbEl.dataset.err = err.message || 'erreur';
    console.warn('[OBS preview]', sceneName, err);
  }
}

async function previewTick() {
  if (obsPreviewInFlight) return;
  if (document.hidden) return;
  if (obs.state !== 'connected') return;
  if (isPreviewSectionCollapsed()) return;

  obsPreviewInFlight = true;
  try {
    const programThumb = document.getElementById('obsThumbProgram');
    const programImg = document.getElementById('obsThumbProgramImg');
    const previewThumb = document.getElementById('obsThumbPreview');
    const previewImg = document.getElementById('obsThumbPreviewImg');

    const tasks = [];
    if (obsCurrentScene) tasks.push(captureThumb(obsCurrentScene, programImg, programThumb));
    if (obsStudioMode && obsPreviewScene) tasks.push(captureThumb(obsPreviewScene, previewImg, previewThumb));
    await Promise.all(tasks);
  } finally {
    obsPreviewInFlight = false;
  }
}

function startPreviewPolling() {
  stopPreviewPolling();
  if (!obsPreviewFps || obsPreviewFps <= 0) return;
  const intervalMs = Math.max(100, Math.round(1000 / obsPreviewFps));
  previewTick();
  obsPreviewTimer = setInterval(previewTick, intervalMs);
}

function stopPreviewPolling() {
  if (obsPreviewTimer) { clearInterval(obsPreviewTimer); obsPreviewTimer = null; }
  obsPreviewInFlight = false;
}

function setPreviewFps(fps) {
  obsPreviewFps = Number(fps) || 0;
  const ui = loadUiState();
  ui.previewFps = obsPreviewFps;
  saveUiState(ui);
  if (obs.state === 'connected') startPreviewPolling();

  // Reset Program/Preview src when off, sinon laisse la dernière image
  if (obsPreviewFps === 0) {
    const p = document.getElementById('obsThumbProgramImg');
    const v = document.getElementById('obsThumbPreviewImg');
    if (p) p.removeAttribute('src');
    if (v) v.removeAttribute('src');
  }
}

function updatePreviewThumbsVisibility() {
  const previewThumb = document.getElementById('obsThumbPreview');
  const programThumb = document.getElementById('obsThumbProgram');
  if (previewThumb) previewThumb.style.display = obsStudioMode ? 'block' : 'none';
  if (programThumb) programThumb.classList.toggle('live', true);
}

// =================================================================
// Modales
// =================================================================

function openObsSettings() {
  const modal = document.getElementById('obsSettingsModal');
  const s = loadObsSettings();
  document.getElementById('obsHost').value = s.host;
  document.getElementById('obsPort').value = s.port;
  document.getElementById('obsPassword').value = s.password;
  document.getElementById('obsAutoConnect').checked = s.autoConnect;
  modal.classList.add('show');
}
function closeObsSettings() { document.getElementById('obsSettingsModal').classList.remove('show'); }
function openShortcuts() { document.getElementById('obsShortcutsModal').classList.add('show'); }
function closeShortcuts() { document.getElementById('obsShortcutsModal').classList.remove('show'); }

// =================================================================
// Raccourcis clavier
// =================================================================

function isTextInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function setupShortcuts() {
  document.addEventListener('keydown', async (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextInputFocused()) return;

    // Esc = effacer écran (toujours dispo, géré ailleurs aussi, mais on s'assure)
    if (e.key === 'Escape') {
      const clearBtn = document.getElementById('clearLiveBtn');
      if (clearBtn) clearBtn.click();
      return;
    }

    if (obs.state !== 'connected') return;

    // 1-9 : scènes
    if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const target = obsStudioMode ? 'SetCurrentPreviewScene' : 'SetCurrentProgramScene';
      if (obsScenes[idx]) {
        e.preventDefault();
        try { await obs.request(target, { sceneName: obsScenes[idx].sceneName }); }
        catch (err) { obsToast(err.message, true); }
      }
      return;
    }

    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); try { await obs.request('ToggleStream'); } catch (err) { obsToast(err.message, true); } }
    else if (k === 'r') { e.preventDefault(); try { await obs.request('ToggleRecord'); } catch (err) { obsToast(err.message, true); } }
    else if (k === 'p') {
      e.preventDefault();
      try { await obs.request(obsRecordPaused ? 'ResumeRecord' : 'PauseRecord'); }
      catch (err) { obsToast(err.message, true); }
    }
    else if (k === 'b') {
      e.preventDefault();
      try { await obs.request('SaveReplayBuffer'); obsToast('Replay sauvegardé'); }
      catch (err) { obsToast(err.message, true); }
    }
    else if (k === 'm') { e.preventDefault(); toggleMasterMute(); }
    else if (k === 't') { e.preventDefault(); triggerTransition(); }
  });
}

// =================================================================
// Utilitaires DOM
// =================================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =================================================================
// Bind UI
// =================================================================

function bindObsUi() {
  bindCollapsibles();

  document.getElementById('obsConnectBtn').addEventListener('click', connectObs);
  document.getElementById('obsSettingsBtn').addEventListener('click', openObsSettings);
  document.getElementById('obsRefreshBtn').addEventListener('click', initialFetch);
  document.getElementById('obsHelpBtn').addEventListener('click', openShortcuts);

  // Stream / record / replay
  document.getElementById('obsStreamBtn').addEventListener('click', async () => {
    try { await obs.request('ToggleStream'); refreshStreamStatus(); }
    catch (err) { obsToast(err.message, true); }
  });
  document.getElementById('obsRecordBtn').addEventListener('click', async () => {
    try { await obs.request('ToggleRecord'); refreshStreamStatus(); }
    catch (err) { obsToast(err.message, true); }
  });
  document.getElementById('obsRecordPauseBtn').addEventListener('click', async () => {
    try { await obs.request(obsRecordPaused ? 'ResumeRecord' : 'PauseRecord'); refreshStreamStatus(); }
    catch (err) { obsToast(err.message, true); }
  });
  document.getElementById('obsReplayToggleBtn').addEventListener('click', async () => {
    try {
      await obs.request(obsReplayActive ? 'StopReplayBuffer' : 'StartReplayBuffer');
      refreshReplayStatus();
    } catch (err) { obsToast(err.message, true); }
  });
  document.getElementById('obsReplaySaveBtn').addEventListener('click', async () => {
    try { await obs.request('SaveReplayBuffer'); obsToast('Replay sauvegardé'); }
    catch (err) { obsToast(err.message, true); }
  });

  // Aperçu live (FPS persisté)
  const fpsSel = document.getElementById('obsPreviewFps');
  const uiState = loadUiState();
  if (typeof uiState.previewFps === 'number') {
    obsPreviewFps = uiState.previewFps;
    fpsSel.value = String(uiState.previewFps);
  }
  fpsSel.addEventListener('change', (e) => setPreviewFps(e.target.value));

  // Studio mode + transitions
  document.getElementById('obsStudioMode').addEventListener('change', (e) => toggleStudioMode(e.target.checked));
  document.getElementById('obsTransitionBtn').addEventListener('click', triggerTransition);
  document.getElementById('obsTransitionType').addEventListener('change', async (e) => {
    try { await obs.request('SetCurrentSceneTransition', { transitionName: e.target.value }); }
    catch (err) { obsToast(err.message, true); }
  });
  const durSlider = document.getElementById('obsTransitionDuration');
  durSlider.addEventListener('input', () => {
    document.getElementById('obsTransitionDurationVal').textContent = durSlider.value + ' ms';
  });
  durSlider.addEventListener('change', async () => {
    try { await obs.request('SetCurrentSceneTransitionDuration', { transitionDuration: parseInt(durSlider.value, 10) }); }
    catch (err) { obsToast(err.message, true); }
  });

  // Modales
  document.getElementById('obsSettingsClose').addEventListener('click', closeObsSettings);
  document.getElementById('obsSettingsCancel').addEventListener('click', closeObsSettings);
  document.getElementById('obsSettingsSave').addEventListener('click', async () => {
    const settings = {
      host: document.getElementById('obsHost').value.trim() || 'localhost',
      port: parseInt(document.getElementById('obsPort').value, 10) || 4455,
      password: document.getElementById('obsPassword').value,
      autoConnect: document.getElementById('obsAutoConnect').checked,
    };
    saveObsSettings(settings);
    closeObsSettings();
    if (obs.state === 'connected') obs.disconnect();
    try {
      await obs.connect(settings.host, settings.port, settings.password);
      obsToast('Connecté à OBS');
      await initialFetch();
      syncAudioMetersSubscription();
      startStatusPolling();
      startStatsPolling();
      startPreviewPolling();
    } catch (err) { obsToast(err.message, true); }
  });

  // Capture immédiate quand on déplie la section Aperçu, ou quand l'onglet redevient visible
  const previewSub = document.querySelector('.obs-sub[data-key="preview"]');
  if (previewSub) {
    previewSub.querySelector('.obs-sub-head').addEventListener('click', () => {
      if (!previewSub.classList.contains('collapsed') && obs.state === 'connected') previewTick();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && obs.state === 'connected') previewTick();
  });
  document.getElementById('obsShortcutsClose').addEventListener('click', closeShortcuts);
  document.getElementById('obsShortcutsOk').addEventListener('click', closeShortcuts);

  // Events OBS
  obs.addEventListener('state-change', updateObsConnState);
  obs.addEventListener('disconnected', () => { stopStatusPolling(); stopStatsPolling(); stopPreviewPolling(); });
  obs.addEventListener('reconnecting', () => obsToast('Reconnexion à OBS…'));
  obs.addEventListener('obs-event', (e) => {
    const { type, data } = e.detail;
    if (type === 'CurrentProgramSceneChanged') {
      obsCurrentScene = data.sceneName;
      renderScenes();
      refreshSceneItems();
      previewTick();
    } else if (type === 'CurrentPreviewSceneChanged') {
      obsPreviewScene = data.sceneName;
      renderScenes();
      previewTick();
    } else if (type === 'StudioModeStateChanged') {
      obsStudioMode = !!data.studioModeEnabled;
      document.getElementById('obsStudioMode').checked = obsStudioMode;
      document.getElementById('obsPreviewWrap').style.display = obsStudioMode ? 'block' : 'none';
      updatePreviewThumbsVisibility();
      if (obsStudioMode) refreshScenes();
    } else if (type === 'SceneListChanged' || type === 'SceneCreated' || type === 'SceneRemoved' || type === 'SceneNameChanged') {
      refreshScenes();
    } else if (type === 'StreamStateChanged' || type === 'RecordStateChanged' || type === 'RecordPauseStateChanged') {
      refreshStreamStatus();
    } else if (type === 'ReplayBufferStateChanged') {
      refreshReplayStatus();
    } else if (type === 'ReplayBufferSaved') {
      obsToast('Replay : ' + (data.savedReplayPath || 'sauvegardé'));
    } else if (type === 'InputMuteStateChanged') {
      const inp = obsAudioInputs.find(i => i.name === data.inputName);
      if (inp) { inp.muted = !!data.inputMuted; renderMixer(); }
    } else if (type === 'InputVolumeChanged') {
      const inp = obsAudioInputs.find(i => i.name === data.inputName);
      if (inp) inp.volumeDb = data.inputVolumeDb;
    } else if (type === 'InputCreated' || type === 'InputRemoved' || type === 'InputNameChanged') {
      refreshAudioInputs();
    } else if (type === 'SceneItemEnableStateChanged') {
      const item = obsSceneItems.find(i => i.sceneItemId === data.sceneItemId);
      if (item) { item.sceneItemEnabled = !!data.sceneItemEnabled; renderSources(); }
    } else if (type === 'SceneItemCreated' || type === 'SceneItemRemoved' || type === 'SceneItemListReindexed') {
      refreshSceneItems();
    } else if (type === 'CurrentSceneTransitionChanged') {
      obsCurrentTransition = data.transitionName;
      const sel = document.getElementById('obsTransitionType');
      if (sel) sel.value = data.transitionName;
    } else if (type === 'CurrentSceneTransitionDurationChanged') {
      obsTransitionDuration = data.transitionDuration;
      document.getElementById('obsTransitionDuration').value = obsTransitionDuration;
      document.getElementById('obsTransitionDurationVal').textContent = obsTransitionDuration + ' ms';
    } else if (type === 'InputVolumeMeters') {
      applyVolumeMeters(data.inputs || []);
    }
  });

  setupShortcuts();
  updateObsConnState();

  const s = loadObsSettings();
  if (s.autoConnect) setTimeout(connectObs, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindObsUi);
} else {
  bindObsUi();
}
