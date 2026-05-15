// VersetLive Relay — WebM (MediaRecorder) -> RTMP multi-destinations via ffmpeg tee
//
// Reçoit le flux du Studio via WebSocket (TLS, cert auto-signé),
// pousse en simultané vers N destinations RTMP (YouTube, Facebook, Twitch, ...).
//
// Lancer : `npm start` ou `./start.command` ou `node relay.js`
// Port : 8766 (configurable via RELAY_PORT)

import https from 'node:https';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import ffmpegPath from 'ffmpeg-static';
import selfsigned from 'selfsigned';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.RELAY_PORT || '8766', 10);
const CERT_DIR = join(__dirname, '.certs');
const CERT_FILE = join(CERT_DIR, 'cert.pem');
const KEY_FILE = join(CERT_DIR, 'key.pem');

// ============ Certificat auto-signé (généré une fois) ============
async function ensureCertificate() {
  if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
    return {
      cert: await readFile(CERT_FILE, 'utf8'),
      key: await readFile(KEY_FILE, 'utf8')
    };
  }
  console.log('[relay] Génération du certificat local (valable 10 ans)…');
  const attrs = [
    { name: 'commonName', value: 'localhost' },
    { name: 'organizationName', value: 'VersetLive' }
  ];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' }
        ]
      }
    ]
  });
  await mkdir(CERT_DIR, { recursive: true });
  await writeFile(CERT_FILE, pems.cert);
  await writeFile(KEY_FILE, pems.private);
  return { cert: pems.cert, key: pems.private };
}

// ============ Sessions (1 WS = 1 session = N destinations) ============
class StreamSession {
  constructor(ws) {
    this.ws = ws;
    this.ffmpeg = null;
    this.destinations = [];
    this.bytesIn = 0;
    this.startedAt = 0;
    this.stalled = false;
  }

  start(destinations) {
    if (this.ffmpeg) {
      this.stop('restart');
    }
    if (!destinations || !destinations.length) {
      this.send({ type: 'error', message: 'Aucune destination configurée' });
      return;
    }
    this.destinations = destinations;
    this.startedAt = Date.now();
    this.bytesIn = 0;

    // Tee multi-destinations : 1 encodage, N sorties FLV/RTMP
    // [f=flv:onfail=ignore] permet à une destination de tomber sans casser les autres
    const teeArg = destinations
      .map(d => `[f=flv:onfail=ignore]${d.url}/${d.key}`)
      .join('|');

    const args = [
      // Input depuis stdin (WebM/Matroska venant de MediaRecorder)
      '-fflags', '+genpts+igndts',
      '-use_wallclock_as_timestamps', '1',
      '-i', 'pipe:0',
      // Vidéo : h264 baseline-friendly, GOP fixe, faible latence
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      '-b:v', '4500k',
      '-maxrate', '4500k',
      '-bufsize', '9000k',
      '-profile:v', 'high',
      '-level', '4.1',
      // Audio : AAC 128k 44.1kHz
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      // Tee multi-sorties
      '-f', 'tee',
      '-flags', '+global_header',
      teeArg
    ];

    console.log('[relay] ffmpeg', args.join(' '));
    this.ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpeg.stdout.on('data', (d) => process.stdout.write('[ffmpeg] ' + d));
    this.ffmpeg.stderr.on('data', (d) => {
      const line = d.toString();
      process.stderr.write('[ffmpeg] ' + line);
      // Remonter les lignes intéressantes au studio
      if (/error|failed|denied/i.test(line)) {
        this.send({ type: 'ffmpeg-log', level: 'error', line: line.trim() });
      } else if (/frame=/i.test(line)) {
        // Stats line, parse some
        const m = line.match(/frame=\s*(\d+).*fps=\s*([\d.]+).*bitrate=\s*([\d.]+\w+\/s)/);
        if (m) this.send({ type: 'stats', frame: parseInt(m[1]), fps: parseFloat(m[2]), bitrate: m[3] });
      }
    });
    this.ffmpeg.stdin.on('error', (e) => {
      if (e.code !== 'EPIPE') console.warn('[relay] stdin error', e);
    });
    this.ffmpeg.on('close', (code, signal) => {
      console.log(`[relay] ffmpeg closed code=${code} signal=${signal}`);
      this.send({ type: 'stopped', code, signal });
      this.ffmpeg = null;
    });

    this.send({ type: 'started', destinations: destinations.map(d => ({ name: d.name, url: d.url })) });
  }

  push(chunk) {
    if (!this.ffmpeg || !this.ffmpeg.stdin.writable) return;
    try {
      this.ffmpeg.stdin.write(chunk);
      this.bytesIn += chunk.length;
    } catch (e) {
      // backpressure ou pipe fermé
    }
  }

  stop(reason = 'user') {
    if (this.ffmpeg) {
      try {
        if (this.ffmpeg.stdin.writable) this.ffmpeg.stdin.end();
      } catch (e) {}
      // SIGTERM si toujours en vie après 2 sec
      const proc = this.ffmpeg;
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch (e) {} }, 2000);
      this.ffmpeg = null;
    }
    this.send({ type: 'stopped', reason });
  }

  send(msg) {
    if (this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); } catch (e) {}
    }
  }
}

// ============ Serveur HTTPS + WebSocket ============
async function main() {
  const { cert, key } = await ensureCertificate();
  const server = https.createServer({ cert, key }, (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, name: 'versetlive-relay', version: '1.0.0' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><title>VersetLive Relay</title>
      <style>body{font-family:system-ui;background:#0f172a;color:#f1f5f9;padding:40px;max-width:600px;margin:auto;line-height:1.6}
      h1{color:#a855f7}code{background:#1e293b;padding:2px 8px;border-radius:4px}
      .ok{color:#10b981;font-weight:700}</style></head><body>
      <h1>🟢 VersetLive Relay</h1>
      <p class="ok">Certificat accepté avec succès.</p>
      <p>Tu peux fermer cet onglet et retourner sur le Studio. Le bouton « Démarrer le stream » fonctionne maintenant.</p>
      <p style="color:#94a3b8;font-size:13px;margin-top:30px">Le relais tourne sur <code>wss://localhost:${PORT}</code> et attend les connexions du Studio.</p>
      </body></html>`);
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    console.log(`[relay] WS connect from ${req.socket.remoteAddress}`);
    const session = new StreamSession(ws);
    session.send({ type: 'hello', name: 'versetlive-relay', version: '1.0.0', ffmpeg: ffmpegPath });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        session.push(data);
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'start') session.start(msg.destinations);
          else if (msg.type === 'stop') session.stop('user');
          else if (msg.type === 'ping') session.send({ type: 'pong', t: Date.now() });
        } catch (e) {
          console.warn('[relay] bad msg', e.message);
        }
      }
    });

    ws.on('close', () => {
      console.log('[relay] WS close');
      session.stop('disconnect');
    });

    ws.on('error', (e) => console.warn('[relay] WS error', e.message));
  });

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  VersetLive Relay prêt                                       ║
║                                                              ║
║  Listening: wss://localhost:${PORT}                              ║
║  ffmpeg   : ${ffmpegPath?.slice(0, 50) || 'NON TROUVÉ'}        ║
║                                                              ║
║  Première fois ? Va sur https://localhost:${PORT}/ et accepte   ║
║  le certificat (« Avancé » → « Continuer vers localhost »).  ║
║                                                              ║
║  Ctrl+C pour arrêter.                                        ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  process.on('SIGINT', () => {
    console.log('\n[relay] Arrêt demandé…');
    wss.clients.forEach(ws => ws.close());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}

main().catch(err => {
  console.error('[relay] Échec démarrage', err);
  process.exit(1);
});
