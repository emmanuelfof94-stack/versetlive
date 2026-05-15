// Planificateur YouTube Live pour VersetLive
// - OAuth 2.0 implicit via Google Identity Services (gsi/client)
// - Création de broadcasts programmés via YouTube Data API v3
// - Récupération des credentials RTMP, à intégrer en tant que destination du studio
// - Transition broadcast → live (au démarrage) / complete (à la fin)
//
// Client ID OAuth saisi par l'utilisateur (créé dans Google Cloud Console).
// Origines JavaScript autorisées à configurer côté Google :
//   https://versetlive.vercel.app, http://localhost:8765

(function () {
  'use strict';

  // ============ Config & stockage ============
  const STORAGE_CLIENT_ID = 'versetlive:yt-client-id';
  const STORAGE_TOKEN = 'versetlive:yt-token';
  const STORAGE_BROADCASTS = 'versetlive:yt-broadcasts';
  const SCOPE = 'https://www.googleapis.com/auth/youtube';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const API_BASE = 'https://www.googleapis.com/youtube/v3';

  let clientId = localStorage.getItem(STORAGE_CLIENT_ID) || '';
  let token = loadToken();
  let tokenClient = null;
  let cachedBroadcasts = loadBroadcasts();
  let gisLoaded = false;
  let listeners = [];

  function loadToken() {
    try {
      const raw = localStorage.getItem(STORAGE_TOKEN);
      if (!raw) return null;
      const t = JSON.parse(raw);
      if (t.expiresAt && t.expiresAt < Date.now() + 30_000) return null;
      return t;
    } catch (e) { return null; }
  }

  function saveToken(t) {
    token = t;
    if (t) localStorage.setItem(STORAGE_TOKEN, JSON.stringify(t));
    else localStorage.removeItem(STORAGE_TOKEN);
    emit();
  }

  function loadBroadcasts() {
    try {
      const raw = localStorage.getItem(STORAGE_BROADCASTS);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
  }

  function saveBroadcasts() {
    localStorage.setItem(STORAGE_BROADCASTS, JSON.stringify(cachedBroadcasts));
    emit();
  }

  function emit() {
    listeners.forEach(fn => { try { fn(); } catch (e) {} });
  }

  // ============ Google Identity Services ============
  function loadGis() {
    if (gisLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
      if (existing) {
        if (window.google?.accounts?.oauth2) { gisLoaded = true; resolve(); return; }
        existing.addEventListener('load', () => { gisLoaded = true; resolve(); });
        return;
      }
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => { gisLoaded = true; resolve(); };
      s.onerror = () => reject(new Error('Impossible de charger Google Identity Services'));
      document.head.appendChild(s);
    });
  }

  function ensureTokenClient() {
    if (!clientId) throw new Error('Client ID OAuth manquant');
    if (!window.google?.accounts?.oauth2) throw new Error('Google Identity Services pas chargé');
    if (tokenClient && tokenClient._clientId === clientId) return tokenClient;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          console.error('OAuth error', resp);
          tokenClient._reject?.(new Error(resp.error_description || resp.error));
          return;
        }
        const expiresIn = parseInt(resp.expires_in || '3600', 10) * 1000;
        saveToken({
          accessToken: resp.access_token,
          expiresAt: Date.now() + expiresIn,
        });
        tokenClient._resolve?.();
      },
    });
    tokenClient._clientId = clientId;
    return tokenClient;
  }

  // ============ Helpers API ============
  async function apiFetch(method, path, { query, body } = {}) {
    if (!token?.accessToken) throw new Error('Pas connecté à Google');
    const url = new URL(API_BASE + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    const resp = await fetch(url.toString(), {
      method,
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json()).error?.message || ''; } catch (e) {}
      if (resp.status === 401) {
        saveToken(null);
        throw new Error('Session Google expirée — reconnecte-toi');
      }
      throw new Error(`YouTube API ${resp.status}: ${detail || resp.statusText}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  // ============ Création broadcast complet ============
  // Crée : liveStream (RTMP) + liveBroadcast (programmé) + binding entre les deux
  async function createBroadcast({ title, description, scheduledStartTime, privacy }) {
    if (!title) throw new Error('Titre requis');
    if (!scheduledStartTime) throw new Error('Date/heure de début requise');

    // 1. Créer le stream RTMP (réutilisable, mais on en crée un par broadcast pour simplifier)
    const streamResp = await apiFetch('POST', '/liveStreams', {
      query: { part: 'snippet,cdn,contentDetails' },
      body: {
        snippet: { title: `[VersetLive] ${title}` },
        cdn: {
          format: '1080p',
          ingestionType: 'rtmp',
          resolution: '1080p',
          frameRate: '30fps',
        },
        contentDetails: { isReusable: false },
      },
    });

    const streamId = streamResp.id;
    const ingestionAddress = streamResp.cdn?.ingestionInfo?.ingestionAddress;
    const streamName = streamResp.cdn?.ingestionInfo?.streamName;
    if (!ingestionAddress || !streamName) throw new Error('Impossible de récupérer les credentials RTMP');

    // 2. Créer le broadcast
    const broadcastResp = await apiFetch('POST', '/liveBroadcasts', {
      query: { part: 'snippet,status,contentDetails' },
      body: {
        snippet: {
          title,
          description: description || '',
          scheduledStartTime,
        },
        status: {
          privacyStatus: privacy || 'unlisted',
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: false,
          enableAutoStop: false,
          enableDvr: true,
          monitorStream: { enableMonitorStream: false },
        },
      },
    });

    const broadcastId = broadcastResp.id;

    // 3. Bind stream au broadcast
    await apiFetch('POST', '/liveBroadcasts/bind', {
      query: { id: broadcastId, part: 'id', streamId },
    });

    const entry = {
      broadcastId,
      streamId,
      title,
      scheduledStartTime,
      privacy: privacy || 'unlisted',
      rtmpUrl: ingestionAddress,
      rtmpKey: streamName,
      status: 'created', // 'created' | 'live' | 'complete'
      createdAt: Date.now(),
    };
    cachedBroadcasts.push(entry);
    saveBroadcasts();
    return entry;
  }

  async function transitionToLive(broadcastId) {
    await apiFetch('POST', '/liveBroadcasts/transition', {
      query: { id: broadcastId, broadcastStatus: 'live', part: 'id,status' },
    });
    const b = cachedBroadcasts.find(x => x.broadcastId === broadcastId);
    if (b) { b.status = 'live'; saveBroadcasts(); }
  }

  async function finalize(broadcastId) {
    await apiFetch('POST', '/liveBroadcasts/transition', {
      query: { id: broadcastId, broadcastStatus: 'complete', part: 'id,status' },
    });
    const b = cachedBroadcasts.find(x => x.broadcastId === broadcastId);
    if (b) { b.status = 'complete'; saveBroadcasts(); }
  }

  async function deleteBroadcast(broadcastId) {
    await apiFetch('DELETE', '/liveBroadcasts', { query: { id: broadcastId } });
    cachedBroadcasts = cachedBroadcasts.filter(x => x.broadcastId !== broadcastId);
    saveBroadcasts();
  }

  async function refreshFromYouTube() {
    // Synchronise le cache avec l'état réel YouTube
    const resp = await apiFetch('GET', '/liveBroadcasts', {
      query: { part: 'snippet,status,contentDetails', mine: 'true', maxResults: 25, broadcastType: 'all' },
    });
    const items = resp.items || [];
    // Met à jour le statut des broadcasts qu'on connaît déjà
    items.forEach(item => {
      const local = cachedBroadcasts.find(x => x.broadcastId === item.id);
      if (local) {
        local.status = mapBroadcastStatus(item.status?.lifeCycleStatus);
        local.title = item.snippet?.title || local.title;
        local.scheduledStartTime = item.snippet?.scheduledStartTime || local.scheduledStartTime;
      }
    });
    saveBroadcasts();
    return cachedBroadcasts;
  }

  function mapBroadcastStatus(lifeCycle) {
    if (!lifeCycle) return 'created';
    if (lifeCycle === 'live') return 'live';
    if (lifeCycle === 'complete' || lifeCycle === 'completed' || lifeCycle === 'revoked') return 'complete';
    return 'created';
  }

  // ============ API publique ============
  window.YouTubeScheduler = {
    init({ onChange } = {}) {
      if (onChange) listeners.push(onChange);
      // Précharge GIS si Client ID déjà saisi (sinon attend une action user)
      if (clientId) loadGis().catch(e => console.warn('GIS preload', e));
    },

    isConfigured() { return !!clientId; },
    isConnected() { return !!(token?.accessToken && token.expiresAt > Date.now() + 30_000); },
    getClientId() { return clientId; },

    setClientId(id) {
      clientId = (id || '').trim();
      if (clientId) localStorage.setItem(STORAGE_CLIENT_ID, clientId);
      else localStorage.removeItem(STORAGE_CLIENT_ID);
      // Token invalidé si Client ID change
      tokenClient = null;
      saveToken(null);
    },

    async connect() {
      if (!clientId) throw new Error('Saisis d\'abord ton Client ID OAuth Google');
      await loadGis();
      const tc = ensureTokenClient();
      return new Promise((resolve, reject) => {
        tc._resolve = resolve;
        tc._reject = reject;
        tc.requestAccessToken({ prompt: '' });
      });
    },

    disconnect() {
      if (token?.accessToken && window.google?.accounts?.oauth2) {
        try { window.google.accounts.oauth2.revoke(token.accessToken, () => {}); } catch (e) {}
      }
      saveToken(null);
    },

    getBroadcasts() { return cachedBroadcasts.slice(); },
    getUpcoming() {
      return cachedBroadcasts
        .filter(b => b.status !== 'complete')
        .sort((a, b) => new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime));
    },

    createBroadcast,
    transitionToLive,
    finalize,
    deleteBroadcast,
    refreshFromYouTube,
  };
})();
