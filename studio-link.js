// Lien live entre le panneau principal (index.html) et le Studio (studio.html).
// Le Studio diffuse son état toutes les 2 s sur le canal versetlive:studio-link.
// Le panneau écoute, met à jour le mini-bloc 🎬 Studio (intégré), et considère
// le Studio "fermé" s'il n'a rien reçu depuis 5 s.

(function () {
  const CHANNEL = 'versetlive:studio-link';
  const STALE_MS = 5000;

  const dot   = document.getElementById('studioLinkDot');
  const label = document.getElementById('studioLinkLabel');
  const scene = document.getElementById('studioLinkScene');
  const stream = document.getElementById('studioLinkStreamBadge');
  const record = document.getElementById('studioLinkRecordBadge');
  if (!dot || !label) return; // section absente → rien à faire

  let lastSeenAt = 0;
  let lastState = null;

  let bc;
  try { bc = new BroadcastChannel(CHANNEL); }
  catch (e) { return; }

  bc.onmessage = (ev) => {
    const msg = ev?.data || {};
    if (msg.type === 'state') {
      lastState = msg.state || {};
      lastSeenAt = Date.now();
      render();
    }
  };

  function render() {
    const open = lastState && (Date.now() - lastSeenAt) < STALE_MS;
    dot.classList.toggle('connected', !!open);
    label.textContent = open ? 'Ouvert' : 'Fermé';
    if (open) {
      scene.textContent = lastState.sceneLabel || '—';
      const streaming = !!lastState.streaming;
      stream.textContent = streaming ? '🔴 en direct' : 'arrêtée';
      stream.classList.toggle('live', streaming);
      const recording = !!lastState.recording;
      record.textContent = recording ? '🔴 enregistre' : 'arrêté';
      record.classList.toggle('live', recording);
    } else {
      scene.textContent = '—';
      stream.textContent = 'arrêtée'; stream.classList.remove('live');
      record.textContent = 'arrêté';  record.classList.remove('live');
    }
  }

  // Re-évalue la fraîcheur (le Studio peut ne plus diffuser sans envoyer "close").
  setInterval(render, 1500);
  render();
})();
