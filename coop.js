// ============ Coopération multi-postes (VLCoop) ============
// Host = le PC qui rend le studio (canvas, captureStream, RTMP, projecteur).
// Co-pilot = un PC distant qui se connecte au host avec un code 4 caractères.
//   - Reçoit Program + Preview en WebRTC (visu live)
//   - Reçoit l'état (scènes, sources, destinations, modes, verset) via data channel
//   - Envoie des commandes (changer scène, Take, push verset, démarrer stream…)
//
// Signaling : PeerJS Cloud (broker public, gratuit). Instance Peer dédiée à la
// coop, distincte de celle des caméras téléphone (versetlive-studio-*).
//
// API exposée : window.VLCoop = { startHost, joinAsCoPilot, generateCode, stop }
(function () {
  'use strict';

  const COOP_PEER_PREFIX = 'versetlive-coop-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function generateCode() {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  // ====== Config ICE (TURN) ======
  // Entre réseaux différents, une connexion WebRTC directe échoue souvent
  // (NAT strict, pare-feu) → il faut un relais TURN. On récupère des identifiants
  // TURN Cloudflare éphémères via /api/turn. Le résultat est mis en cache pour
  // toute la session (un seul appel réseau, partagé host + copilotes).
  //
  // Renvoie une promesse vers un objet RTCConfiguration { iceServers: [...] },
  // ou null en cas d'échec (PeerJS retombe alors sur ses serveurs par défaut).
  let _iceConfigPromise = null;
  function loadIceConfig() {
    if (_iceConfigPromise) return _iceConfigPromise;
    _iceConfigPromise = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000); // ne bloque pas la création du Peer
        const r = await fetch('/api/turn', { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const ice = data && data.iceServers;
        const servers = [];
        if (Array.isArray(ice)) servers.push(...ice);
        else if (ice) servers.push(ice);
        if (!servers.length) throw new Error('aucun serveur ICE renvoyé');
        // STUN Google en secours (en plus du STUN/TURN Cloudflare).
        servers.push({ urls: 'stun:stun.l.google.com:19302' });
        return { iceServers: servers };
      } catch (e) {
        console.warn('[Coop] TURN indisponible, fallback PeerJS par défaut :', e && e.message || e);
        return null;
      }
    })();
    return _iceConfigPromise;
  }

  // Construit les options du Peer en injectant la config ICE si disponible.
  function peerOptionsWith(config) {
    const o = { debug: 1 };
    if (config) o.config = config; // sinon PeerJS garde ses serveurs par défaut
    return o;
  }

  // ====== Host ======
  // opts = {
  //   code: string,
  //   programStreamFn: () => MediaStream | null,  // appelé à chaque connexion co-pilot
  //   previewStreamFn: () => MediaStream | null,
  //   stateFn: () => stateSnapshot,               // appelé après chaque mutation
  //   onCommand: (cmd, args, copilotMeta) => void,
  //   onCoPilotChange: (count, list) => void,     // notif UI : nb connectés
  //   onStatus: (text, kind) => void,             // notif UI : statut connexion
  // }
  function startHost(opts) {
    if (!window.Peer) throw new Error('PeerJS non chargé');
    const code = (opts.code || generateCode()).toUpperCase();
    const peerId = COOP_PEER_PREFIX + code;
    let peer = null; // créé après chargement de la config ICE (TURN)

    // copilotId → { conn, programCall, previewCall, meta }
    // Map = insertion order préservé → utilisé pour l'ordre d'élection (phase 3).
    const copilots = new Map();
    let heartbeatTimer = null;

    const coPilotIds = () => Array.from(copilots.keys());

    const notifyChange = () => {
      const list = Array.from(copilots.values()).map(c => c.meta || { name: 'Co-pilot' });
      try { opts.onCoPilotChange && opts.onCoPilotChange(copilots.size, list); } catch (e) {}
    };

    const sendTo = (entry, msg) => {
      if (!entry || !entry.conn || !entry.conn.open) return;
      try { entry.conn.send(msg); } catch (e) {}
    };

    const sendAll = (msg) => {
      copilots.forEach(entry => sendTo(entry, msg));
    };

    // Heartbeat 3 s : le co-pilot détecte la mort du host par absence de battements.
    // On joint la liste ordonnée des co-pilots pour permettre l'élection côté guest.
    const sendHeartbeat = () => {
      if (!copilots.size) return;
      sendAll({ type: 'heartbeat', ts: Date.now(), coPilotIds: coPilotIds() });
    };

    const callCoPilot = (entry) => {
      // (re)appelle les pistes Program + Preview vers ce co-pilot
      try {
        const ps = opts.programStreamFn && opts.programStreamFn();
        if (ps) {
          if (entry.programCall) { try { entry.programCall.close(); } catch (e) {} }
          entry.programCall = peer.call(entry.copilotId, ps, { metadata: { kind: 'program' } });
          entry.programCall.on('close', () => { if (entry.programCall) entry.programCall = null; });
          entry.programCall.on('error', () => { entry.programCall = null; });
        }
      } catch (e) { console.warn('program call err', e); }
      try {
        const pv = opts.previewStreamFn && opts.previewStreamFn();
        if (pv) {
          if (entry.previewCall) { try { entry.previewCall.close(); } catch (e) {} }
          entry.previewCall = peer.call(entry.copilotId, pv, { metadata: { kind: 'preview' } });
          entry.previewCall.on('close', () => { if (entry.previewCall) entry.previewCall = null; });
          entry.previewCall.on('error', () => { entry.previewCall = null; });
        }
      } catch (e) { console.warn('preview call err', e); }
      try {
        const mv = opts.multiviewStreamFn && opts.multiviewStreamFn();
        if (mv) {
          if (entry.multiviewCall) { try { entry.multiviewCall.close(); } catch (e) {} }
          entry.multiviewCall = peer.call(entry.copilotId, mv, { metadata: { kind: 'multiview' } });
          entry.multiviewCall.on('close', () => { if (entry.multiviewCall) entry.multiviewCall = null; });
          entry.multiviewCall.on('error', () => { entry.multiviewCall = null; });
        }
      } catch (e) { console.warn('multiview call err', e); }
    };

    // Le Peer n'est créé qu'après chargement de la config ICE (relais TURN),
    // pour que la négociation WebRTC dispose d'un chemin réseau fiable.
    loadIceConfig().then((iceConfig) => {
    peer = new Peer(peerId, peerOptionsWith(iceConfig));

    peer.on('open', () => {
      opts.onStatus && opts.onStatus(`Session ${code} prête`, 'ok');
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(sendHeartbeat, 3000);
    });

    // Caméra contribuée par un co-pilot : il appelle peer avec son flux webcam.
    // metadata = { kind: 'camera-contrib', deviceLabel, copilotName? }
    peer.on('call', (call) => {
      call.answer(); // pas de stream en retour
      call.on('stream', (stream) => {
        const meta = call.metadata || {};
        const copilotEntry = copilots.get(call.peer);
        const copilotName = (copilotEntry && copilotEntry.meta && copilotEntry.meta.name) || meta.copilotName || 'Co-pilot';
        if (opts.onCoPilotCamera) {
          try {
            opts.onCoPilotCamera(stream, { peer: call.peer, name: copilotName, deviceLabel: meta.deviceLabel || '' }, call);
          } catch (e) { console.warn('onCoPilotCamera err', e); }
        }
      });
    });

    peer.on('connection', (conn) => {
      const copilotId = conn.peer;
      const entry = {
        copilotId,
        conn,
        programCall: null,
        previewCall: null,
        multiviewCall: null,
        meta: conn.metadata || { name: 'Co-pilot' },
      };
      copilots.set(copilotId, entry);

      conn.on('open', () => {
        // Hello + état initial + heartbeat immédiat
        sendTo(entry, { type: 'hello', hostName: opts.hostName || 'Studio principal', code });
        try { sendTo(entry, { type: 'state', payload: opts.stateFn ? opts.stateFn() : {} }); } catch (e) {}
        sendTo(entry, { type: 'heartbeat', ts: Date.now(), coPilotIds: coPilotIds() });
        // Puis appel des flux Program + Preview
        setTimeout(() => callCoPilot(entry), 250);
        notifyChange();
      });

      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'cmd' && opts.onCommand) {
          try { opts.onCommand(msg.cmd, msg.args || {}, entry.meta); } catch (e) { console.warn('cmd err', msg.cmd, e); }
        } else if (msg.type === 'identify') {
          entry.meta = msg.meta || entry.meta;
          notifyChange();
        } else if (msg.type === 'request-state') {
          try { sendTo(entry, { type: 'state', payload: opts.stateFn ? opts.stateFn() : {} }); } catch (e) {}
        } else if (msg.type === 'request-recall') {
          // Co-pilot a perdu un flux → on relance les appels media
          callCoPilot(entry);
        }
      });

      conn.on('close', () => {
        if (entry.programCall) try { entry.programCall.close(); } catch (e) {}
        if (entry.previewCall) try { entry.previewCall.close(); } catch (e) {}
        if (entry.multiviewCall) try { entry.multiviewCall.close(); } catch (e) {}
        copilots.delete(copilotId);
        notifyChange();
      });

      conn.on('error', () => {
        copilots.delete(copilotId);
        notifyChange();
      });
    });

    peer.on('error', (err) => {
      console.warn('Coop host peer err', err.type, err);
      if (err.type === 'unavailable-id') {
        opts.onStatus && opts.onStatus('Code déjà pris — génère-en un nouveau', 'err');
      } else if (err.type === 'network' || err.type === 'disconnected') {
        opts.onStatus && opts.onStatus('Hors-ligne — reconnexion…', 'err');
        setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000);
      } else {
        opts.onStatus && opts.onStatus('Erreur : ' + err.type, 'err');
      }
    });

    peer.on('disconnected', () => {
      opts.onStatus && opts.onStatus('Déconnecté — reconnexion…', 'err');
      setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000);
    });
    }); // loadIceConfig().then — fin de l'init du Peer host

    return {
      code,
      broadcastState() {
        if (!copilots.size) return;
        try { sendAll({ type: 'state', payload: opts.stateFn ? opts.stateFn() : {} }); } catch (e) {}
      },
      broadcastToast(message, isError) {
        sendAll({ type: 'toast', message, isError: !!isError });
      },
      recallAll() {
        // Rappelle Program/Preview à tous (utilisé quand programStream est reconstruit)
        copilots.forEach(entry => callCoPilot(entry));
      },
      coPilotCount: () => copilots.size,
      coPilotList: () => Array.from(copilots.values()).map(c => c.meta || { name: 'Co-pilot' }),
      stop() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        copilots.forEach(entry => {
          if (entry.programCall) try { entry.programCall.close(); } catch (e) {}
          if (entry.previewCall) try { entry.previewCall.close(); } catch (e) {}
          if (entry.conn) try { entry.conn.close(); } catch (e) {}
        });
        copilots.clear();
        try { peer.destroy(); } catch (e) {}
        notifyChange();
      },
    };
  }

  // ====== Co-pilot ======
  // opts = {
  //   name: string,
  //   onProgramStream: (stream) => void,
  //   onPreviewStream: (stream) => void,
  //   onState: (state) => void,
  //   onHello: ({ hostName, code }) => void,
  //   onToast: (msg, isError) => void,
  //   onStatus: (text, kind) => void,
  //   onHostLost: ({ myPeerId, coPilotIds, lastState }) => void,  // phase 3 failover
  //   onHostBack: () => void,                                     // phase 3 failover
  // }
  function joinAsCoPilot(code, opts) {
    if (!window.Peer) throw new Error('PeerJS non chargé');
    code = String(code || '').toUpperCase().trim();
    if (!code) throw new Error('Code manquant');

    let peer = null; // créé après chargement de la config ICE (TURN)
    const hostPeerId = COOP_PEER_PREFIX + code;
    let hostConn = null;
    let programStream = null;
    let previewStream = null;
    let multiviewStream = null;
    let myPeerId = null;
    let hasBeenConnected = false;          // une fois true → on autorise le mode failover
    let hostLost = false;
    let lastHeartbeat = 0;
    let lastCoPilotIds = [];
    let lastState = null;                  // dernier snapshot reçu (utilisé au take-over)
    let watchdogTimer = null;
    let reconnectTimer = null;
    let initialConnectTimer = null;
    const HEARTBEAT_TIMEOUT_MS = 8000;
    const RECONNECT_INTERVAL_MS = 3000;

    const ensureRecall = () => {
      if (hostConn && hostConn.open) {
        try { hostConn.send({ type: 'request-recall' }); } catch (e) {}
      }
    };

    const markHostLost = () => {
      if (hostLost) return;
      hostLost = true;
      try {
        opts.onHostLost && opts.onHostLost({ myPeerId, coPilotIds: lastCoPilotIds.slice(), lastState });
      } catch (e) { console.warn('onHostLost err', e); }
    };

    const markHostBack = () => {
      if (!hostLost) return;
      hostLost = false;
      try { opts.onHostBack && opts.onHostBack(); } catch (e) {}
    };

    const scheduleReconnect = () => {
      if (reconnectTimer) return;
      if (!peer || peer.destroyed) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (hostConn && hostConn.open) return;
        attemptConnect();
      }, RECONNECT_INTERVAL_MS);
    };

    const attemptConnect = () => {
      if (!peer || peer.destroyed) return;
      if (hostConn && hostConn.open) return;
      let conn;
      try {
        conn = peer.connect(hostPeerId, {
          reliable: true,
          metadata: { name: opts.name || 'Co-pilot' },
        });
      } catch (e) {
        scheduleReconnect();
        return;
      }
      wireConn(conn);
    };

    const wireConn = (conn) => {
      if (initialConnectTimer) clearTimeout(initialConnectTimer);
      initialConnectTimer = setTimeout(() => {
        // Premier appel jamais ouvert → host vraiment introuvable
        if (!hasBeenConnected && !(hostConn && hostConn.open)) {
          opts.onStatus && opts.onStatus(`Host ${code} introuvable`, 'err');
        }
      }, 8000);

      conn.on('open', () => {
        clearTimeout(initialConnectTimer);
        hostConn = conn;
        lastHeartbeat = Date.now();
        if (hasBeenConnected && hostLost) {
          // Reconnexion réussie après perte du host (peut-être un nouveau host !)
          markHostBack();
          // Demande un état frais : on n'est plus sûr de rien
          try { conn.send({ type: 'request-state' }); } catch (e) {}
        }
        hasBeenConnected = true;
        opts.onStatus && opts.onStatus(`Connecté au host ${code}`, 'ok');
      });

      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hello') {
          opts.onHello && opts.onHello({ hostName: msg.hostName, code: msg.code });
        } else if (msg.type === 'state') {
          lastState = msg.payload || {};
          opts.onState && opts.onState(lastState);
        } else if (msg.type === 'toast') {
          opts.onToast && opts.onToast(msg.message, msg.isError);
        } else if (msg.type === 'heartbeat') {
          lastHeartbeat = Date.now();
          if (Array.isArray(msg.coPilotIds)) lastCoPilotIds = msg.coPilotIds;
          if (hostLost) markHostBack();
        }
      });

      conn.on('close', () => {
        if (hostConn === conn) hostConn = null;
        if (hasBeenConnected) {
          markHostLost();
          scheduleReconnect();
        }
      });

      conn.on('error', (err) => {
        const type = (err && (err.type || err.message)) || '';
        if (hasBeenConnected) {
          if (hostConn === conn) hostConn = null;
          markHostLost();
          scheduleReconnect();
        } else if (type === 'negotiation-failed') {
          // La signalisation a marché (host joignable) mais aucun chemin réseau
          // ICE n'a pu être établi — typiquement entre deux réseaux sans relais
          // TURN fiable. On retente : un autre chemin (TURN) peut réussir ensuite.
          if (hostConn === conn) hostConn = null;
          opts.onStatus && opts.onStatus('Connexion réseau difficile — nouvelle tentative…', 'err');
          scheduleReconnect();
        } else {
          // Jamais connecté + autre erreur → on informe et on retente quand même.
          opts.onStatus && opts.onStatus('Erreur connexion : ' + type, 'err');
          scheduleReconnect();
        }
      });
    };

    // Le Peer n'est créé qu'après chargement de la config ICE (relais TURN),
    // pour disposer d'un chemin réseau fiable même entre réseaux différents.
    loadIceConfig().then((iceConfig) => {
    peer = new Peer(peerOptionsWith(iceConfig));

    peer.on('open', (id) => {
      myPeerId = id;
      attemptConnect();
      // Watchdog : déclenche failover si aucun heartbeat depuis HEARTBEAT_TIMEOUT_MS
      if (!watchdogTimer) {
        watchdogTimer = setInterval(() => {
          if (!hasBeenConnected) return;
          const age = Date.now() - lastHeartbeat;
          if (age > HEARTBEAT_TIMEOUT_MS && !hostLost) markHostLost();
        }, 1000);
      }
    });

    peer.on('call', (call) => {
      call.answer(); // on n'envoie rien en retour
      call.on('stream', (stream) => {
        const kind = call.metadata && call.metadata.kind;
        if (kind === 'preview') {
          previewStream = stream;
          opts.onPreviewStream && opts.onPreviewStream(stream);
        } else if (kind === 'multiview') {
          multiviewStream = stream;
          opts.onMultiviewStream && opts.onMultiviewStream(stream);
        } else {
          programStream = stream;
          opts.onProgramStream && opts.onProgramStream(stream);
        }
      });
      call.on('close', () => {
        const kind = call.metadata && call.metadata.kind;
        if (kind === 'preview') previewStream = null;
        else if (kind === 'multiview') multiviewStream = null;
        else programStream = null;
        // Demande à ré-appeler après court délai
        setTimeout(ensureRecall, 1500);
      });
      call.on('error', () => {
        setTimeout(ensureRecall, 1500);
      });
    });

    peer.on('error', (err) => {
      console.warn('Coop copilot peer err', err.type, err);
      if (err.type === 'peer-unavailable') {
        // Host pas en ligne. Si on l'avait connu : c'est une perte de host → failover
        // (le watchdog l'aurait fait, mais ça accélère). Sinon c'est l'erreur initiale.
        if (hasBeenConnected) {
          markHostLost();
          scheduleReconnect();
        } else {
          opts.onStatus && opts.onStatus(`Host ${code} introuvable`, 'err');
        }
      } else if (err.type === 'network' || err.type === 'disconnected') {
        opts.onStatus && opts.onStatus('Hors-ligne — reconnexion…', 'err');
        setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000);
      } else {
        opts.onStatus && opts.onStatus('Erreur : ' + err.type, 'err');
      }
    });

    peer.on('disconnected', () => {
      opts.onStatus && opts.onStatus('Déconnecté — reconnexion…', 'err');
      setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000);
    });
    }); // loadIceConfig().then — fin de l'init du Peer copilote

    return {
      code,
      sendCommand(cmd, args) {
        if (!hostConn || !hostConn.open) return false;
        try { hostConn.send({ type: 'cmd', cmd, args: args || {} }); return true; }
        catch (e) { return false; }
      },
      requestState() {
        if (!hostConn || !hostConn.open) return;
        try { hostConn.send({ type: 'request-state' }); } catch (e) {}
      },
      // Phase 2 : partager une caméra locale au host. Retourne l'objet call
      // (utilisable pour .close() côté co-pilot quand on stoppe le partage).
      shareCamera(stream, meta) {
        if (!peer) return null; // Peer pas encore initialisé (config ICE en cours)
        const hostPeerId = COOP_PEER_PREFIX + code;
        const call = peer.call(hostPeerId, stream, {
          metadata: {
            kind: 'camera-contrib',
            deviceLabel: (meta && meta.deviceLabel) || '',
            copilotName: (meta && meta.copilotName) || opts.name || 'Co-pilot',
          },
        });
        return call;
      },
      leave() {
        if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (initialConnectTimer) { clearTimeout(initialConnectTimer); initialConnectTimer = null; }
        try { hostConn && hostConn.close(); } catch (e) {}
        try { peer.destroy(); } catch (e) {}
      },
      // Phase 3 : accesseurs utilisés au moment du failover
      getMyPeerId: () => myPeerId,
      getLastState: () => lastState,
    };
  }

  window.VLCoop = { startHost, joinAsCoPilot, generateCode };
})();
