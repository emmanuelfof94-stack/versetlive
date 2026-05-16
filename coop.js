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
    const peer = new Peer(peerId, { debug: 1 });

    // copilotId → { conn, programCall, previewCall, meta }
    const copilots = new Map();

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
    };

    peer.on('open', () => {
      opts.onStatus && opts.onStatus(`Session ${code} prête`, 'ok');
    });

    peer.on('connection', (conn) => {
      const copilotId = conn.peer;
      const entry = {
        copilotId,
        conn,
        programCall: null,
        previewCall: null,
        meta: conn.metadata || { name: 'Co-pilot' },
      };
      copilots.set(copilotId, entry);

      conn.on('open', () => {
        // Hello + état initial
        sendTo(entry, { type: 'hello', hostName: opts.hostName || 'Studio principal', code });
        try { sendTo(entry, { type: 'state', payload: opts.stateFn ? opts.stateFn() : {} }); } catch (e) {}
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
  // }
  function joinAsCoPilot(code, opts) {
    if (!window.Peer) throw new Error('PeerJS non chargé');
    code = String(code || '').toUpperCase().trim();
    if (!code) throw new Error('Code manquant');

    const peer = new Peer({ debug: 1 });
    let hostConn = null;
    let programStream = null;
    let previewStream = null;
    let opened = false;

    const ensureRecall = () => {
      if (hostConn && hostConn.open) {
        try { hostConn.send({ type: 'request-recall' }); } catch (e) {}
      }
    };

    peer.on('open', () => {
      const hostPeerId = COOP_PEER_PREFIX + code;
      const conn = peer.connect(hostPeerId, {
        reliable: true,
        metadata: { name: opts.name || 'Co-pilot' },
      });

      let openTimer = setTimeout(() => {
        if (!opened) opts.onStatus && opts.onStatus(`Host ${code} introuvable`, 'err');
      }, 8000);

      conn.on('open', () => {
        clearTimeout(openTimer);
        opened = true;
        hostConn = conn;
        opts.onStatus && opts.onStatus(`Connecté au host ${code}`, 'ok');
      });

      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hello') {
          opts.onHello && opts.onHello({ hostName: msg.hostName, code: msg.code });
        } else if (msg.type === 'state') {
          opts.onState && opts.onState(msg.payload || {});
        } else if (msg.type === 'toast') {
          opts.onToast && opts.onToast(msg.message, msg.isError);
        }
      });

      conn.on('close', () => {
        hostConn = null;
        opts.onStatus && opts.onStatus('Host déconnecté', 'err');
      });

      conn.on('error', (err) => {
        opts.onStatus && opts.onStatus('Erreur connexion : ' + (err.type || err.message || ''), 'err');
      });
    });

    peer.on('call', (call) => {
      call.answer(); // on n'envoie rien en retour
      call.on('stream', (stream) => {
        const kind = call.metadata && call.metadata.kind;
        if (kind === 'preview') {
          previewStream = stream;
          opts.onPreviewStream && opts.onPreviewStream(stream);
        } else {
          programStream = stream;
          opts.onProgramStream && opts.onProgramStream(stream);
        }
      });
      call.on('close', () => {
        const kind = call.metadata && call.metadata.kind;
        if (kind === 'preview') previewStream = null;
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
        opts.onStatus && opts.onStatus(`Host ${code} introuvable`, 'err');
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
      leave() {
        try { hostConn && hostConn.close(); } catch (e) {}
        try { peer.destroy(); } catch (e) {}
      },
    };
  }

  window.VLCoop = { startHost, joinAsCoPilot, generateCode };
})();
