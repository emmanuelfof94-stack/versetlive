// Contrôle OBS Studio via obs-websocket v5
// Protocole : https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

const OBS_SETTINGS_KEY = 'versetlive:obs-settings';

const OP = {
  HELLO: 0,
  IDENTIFY: 1,
  IDENTIFIED: 2,
  REIDENTIFY: 3,
  EVENT: 5,
  REQUEST: 6,
  REQUEST_RESPONSE: 7,
};

class ObsClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.identified = false;
    this.pending = new Map(); // requestId -> {resolve, reject}
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
      } catch (err) {
        finish(false, err);
        return;
      }

      this.ws.addEventListener('open', () => {
        this.connected = true;
        this._emit('state-change');
      });

      this.ws.addEventListener('message', async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        const { op, d } = msg;

        if (op === OP.HELLO) {
          try {
            await this._handleHello(d);
          } catch (err) {
            finish(false, err);
            this.disconnect(false);
          }
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
          if (d.requestStatus && d.requestStatus.result) {
            p.resolve(d.responseData || {});
          } else {
            p.reject(new Error((d.requestStatus && d.requestStatus.comment) || 'OBS request failed'));
          }
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
    const identifyMsg = { op: OP.IDENTIFY, d: { rpcVersion: d.rpcVersion } };
    if (d.authentication) {
      if (!this.password) throw new Error('OBS demande un mot de passe mais aucun n\'est configuré');
      identifyMsg.d.authentication = await this._authString(this.password, d.authentication.salt, d.authentication.challenge);
    }
    this.ws.send(JSON.stringify(identifyMsg));
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
      this._open().catch(() => {
        if (this.shouldReconnect) this._scheduleReconnect();
      });
    }, 3000);
  }

  disconnect(userInitiated = true) {
    if (userInitiated) this.shouldReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
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
      // Timeout 10s pour éviter qu'une requête reste pendante
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

  // Helpers haut niveau
  getSceneList() { return this.request('GetSceneList'); }
  setCurrentScene(sceneName) { return this.request('SetCurrentProgramScene', { sceneName }); }
  getStreamStatus() { return this.request('GetStreamStatus'); }
  getRecordStatus() { return this.request('GetRecordStatus'); }
  toggleStream() { return this.request('ToggleStream'); }
  toggleRecord() { return this.request('ToggleRecord'); }
  getStats() { return this.request('GetStats'); }
  getSceneItemList(sceneName) { return this.request('GetSceneItemList', { sceneName }); }
  setSceneItemEnabled(sceneName, sceneItemId, enabled) {
    return this.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: enabled });
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

// ====== UI ======

const obs = new ObsClient();
let obsScenes = [];
let obsCurrentScene = null;
let obsStatusTimer = null;

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

async function refreshScenes() {
  try {
    const res = await obs.getSceneList();
    obsCurrentScene = res.currentProgramSceneName;
    obsScenes = (res.scenes || []).slice().reverse(); // OBS retourne en ordre inverse
    renderScenes();
  } catch (err) {
    console.warn('GetSceneList échec', err);
  }
}

function renderScenes() {
  const list = document.getElementById('obsScenesList');
  if (!list) return;
  list.innerHTML = '';
  if (!obsScenes.length) {
    list.innerHTML = '<div class="obs-empty">Aucune scène</div>';
    return;
  }
  obsScenes.forEach(scene => {
    const btn = document.createElement('button');
    btn.className = 'obs-scene-btn' + (scene.sceneName === obsCurrentScene ? ' active' : '');
    btn.textContent = scene.sceneName;
    btn.addEventListener('click', async () => {
      try { await obs.setCurrentScene(scene.sceneName); }
      catch (err) { obsToast('Échec changement de scène : ' + err.message, true); }
    });
    list.appendChild(btn);
  });
}

async function refreshStreamStatus() {
  try {
    const [stream, record] = await Promise.all([obs.getStreamStatus(), obs.getRecordStatus()]);
    const streamBtn = document.getElementById('obsStreamBtn');
    const recordBtn = document.getElementById('obsRecordBtn');
    const streamInfo = document.getElementById('obsStreamInfo');
    const recordInfo = document.getElementById('obsRecordInfo');

    streamBtn.classList.toggle('active', stream.outputActive);
    streamBtn.innerHTML = stream.outputActive ? '⏹ Arrêter le stream' : '▶ Démarrer le stream';

    recordBtn.classList.toggle('active', record.outputActive);
    recordBtn.innerHTML = record.outputActive ? '⏹ Arrêter l\'enreg.' : '⏺ Démarrer l\'enreg.';

    if (stream.outputActive) {
      streamInfo.textContent = `⏱ ${fmtDuration(stream.outputDuration)} · ${fmtBitrate(stream.outputBytes / (stream.outputDuration / 1000 || 1))} · skipped ${stream.outputSkippedFrames || 0}`;
      streamInfo.style.display = 'block';
    } else {
      streamInfo.style.display = 'none';
    }

    if (record.outputActive) {
      recordInfo.textContent = `⏱ ${fmtDuration(record.outputDuration)}${record.outputPaused ? ' · ⏸ pause' : ''}`;
      recordInfo.style.display = 'block';
    } else {
      recordInfo.style.display = 'none';
    }
  } catch (err) {
    // silencieux : les requêtes peuvent échouer transitoirement pendant un changement d'état
  }
}

function startStatusPolling() {
  stopStatusPolling();
  refreshStreamStatus();
  obsStatusTimer = setInterval(refreshStreamStatus, 1500);
}

function stopStatusPolling() {
  if (obsStatusTimer) { clearInterval(obsStatusTimer); obsStatusTimer = null; }
}

function obsToast(msg, isError) {
  const t = document.getElementById('toast');
  if (!t) { console.log(msg); return; }
  t.textContent = msg;
  t.style.background = isError ? 'var(--danger)' : 'var(--success)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function openObsSettings() {
  const modal = document.getElementById('obsSettingsModal');
  const s = loadObsSettings();
  document.getElementById('obsHost').value = s.host;
  document.getElementById('obsPort').value = s.port;
  document.getElementById('obsPassword').value = s.password;
  document.getElementById('obsAutoConnect').checked = s.autoConnect;
  modal.classList.add('show');
}

function closeObsSettings() {
  document.getElementById('obsSettingsModal').classList.remove('show');
}

async function connectObs() {
  const s = loadObsSettings();
  if (obs.state === 'connected') {
    obs.disconnect();
    return;
  }
  try {
    await obs.connect(s.host, s.port, s.password);
    obsToast('Connecté à OBS');
    await refreshScenes();
    startStatusPolling();
  } catch (err) {
    obsToast(err.message, true);
  }
}

function bindObsUi() {
  document.getElementById('obsConnectBtn').addEventListener('click', connectObs);
  document.getElementById('obsSettingsBtn').addEventListener('click', openObsSettings);
  document.getElementById('obsRefreshBtn').addEventListener('click', () => { refreshScenes(); refreshStreamStatus(); });

  document.getElementById('obsStreamBtn').addEventListener('click', async () => {
    try { await obs.toggleStream(); refreshStreamStatus(); }
    catch (err) { obsToast(err.message, true); }
  });

  document.getElementById('obsRecordBtn').addEventListener('click', async () => {
    try { await obs.toggleRecord(); refreshStreamStatus(); }
    catch (err) { obsToast(err.message, true); }
  });

  // Modal settings
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
      await refreshScenes();
      startStatusPolling();
    } catch (err) {
      obsToast(err.message, true);
    }
  });

  // Events depuis OBS
  obs.addEventListener('state-change', updateObsConnState);
  obs.addEventListener('disconnected', () => { stopStatusPolling(); });
  obs.addEventListener('connected', () => { /* déjà géré par connectObs */ });
  obs.addEventListener('reconnecting', () => obsToast('Reconnexion à OBS…'));
  obs.addEventListener('obs-event', (e) => {
    const { type, data } = e.detail;
    if (type === 'CurrentProgramSceneChanged') {
      obsCurrentScene = data.sceneName;
      renderScenes();
    } else if (type === 'SceneListChanged' || type === 'SceneCreated' || type === 'SceneRemoved' || type === 'SceneNameChanged') {
      refreshScenes();
    } else if (type === 'StreamStateChanged' || type === 'RecordStateChanged') {
      refreshStreamStatus();
    }
  });

  updateObsConnState();

  // Auto-connect si configuré
  const s = loadObsSettings();
  if (s.autoConnect) setTimeout(connectObs, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindObsUi);
} else {
  bindObsUi();
}
