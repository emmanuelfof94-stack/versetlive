// Intro / Outro animés pour VersetLive
// - Mode "texte" : titre + sous-titre + logo + countdown, dessiné sur canvas
// - Mode "vidéo" : MP4 importé, joué comme source vidéo dans le canvas
// - Audio MP3 de fond optionnel (mixé dans le programAudioStream)
// Fichiers (logo PNG, vidéo MP4, audio MP3) stockés en IndexedDB local.

(function () {
  'use strict';

  // ============ Config ============
  const STORAGE_KEY = 'versetlive:intro-outro';
  const DEFAULT_CONFIG = {
    intro: {
      mode: 'text',            // 'text' | 'video'
      title: 'Bienvenue',
      subtitle: 'Le service va bientôt commencer',
      bgColor: '#1e3a8a',
      bgColor2: '#831843',
      accentColor: '#d4af37',
      textColor: '#ffffff',
      countdownTo: '',         // 'HH:MM' ou ''
      hasLogo: false,
      hasVideo: false,
      hasAudio: false,
      audioVolume: 0.6,
      audioLoop: true
    },
    outro: {
      mode: 'text',
      title: 'Merci',
      subtitle: 'Que Dieu vous bénisse',
      bgColor: '#1e3a8a',
      bgColor2: '#831843',
      accentColor: '#d4af37',
      textColor: '#ffffff',
      hasLogo: false,
      hasVideo: false,
      hasAudio: false,
      audioVolume: 0.6,
      audioLoop: true
    }
  };

  let config = loadConfig();

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const parsed = JSON.parse(raw);
      return {
        intro: { ...DEFAULT_CONFIG.intro, ...(parsed.intro || {}) },
        outro: { ...DEFAULT_CONFIG.outro, ...(parsed.outro || {}) }
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  function saveConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch (e) {}
  }

  // ============ IndexedDB pour les fichiers volumineux ============
  const DB_NAME = 'versetlive-media';
  const STORE = 'files';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbPut(key, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDel(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============ Assets en mémoire (préchargés) ============
  const assets = {
    intro: { logo: null, logoUrl: null, video: null, videoUrl: null, audio: null, audioUrl: null },
    outro: { logo: null, logoUrl: null, video: null, videoUrl: null, audio: null, audioUrl: null }
  };

  async function loadAssetsFor(kind) {
    const a = assets[kind];
    const c = config[kind];

    // Logo
    if (c.hasLogo) {
      const blob = await idbGet(`${kind}-logo`);
      if (blob) {
        if (a.logoUrl) URL.revokeObjectURL(a.logoUrl);
        a.logoUrl = URL.createObjectURL(blob);
        a.logo = new Image();
        a.logo.src = a.logoUrl;
        await new Promise((res) => { a.logo.onload = res; a.logo.onerror = res; });
      }
    } else {
      if (a.logoUrl) URL.revokeObjectURL(a.logoUrl);
      a.logoUrl = null;
      a.logo = null;
    }

    // Vidéo
    if (c.hasVideo) {
      const blob = await idbGet(`${kind}-video`);
      if (blob) {
        if (a.videoUrl) URL.revokeObjectURL(a.videoUrl);
        a.videoUrl = URL.createObjectURL(blob);
        a.video = document.createElement('video');
        a.video.src = a.videoUrl;
        a.video.muted = true;        // l'audio passe par <audio> séparé
        a.video.loop = true;
        a.video.playsInline = true;
        a.video.preload = 'auto';
      }
    } else {
      if (a.video) { try { a.video.pause(); } catch (e) {} }
      if (a.videoUrl) URL.revokeObjectURL(a.videoUrl);
      a.videoUrl = null;
      a.video = null;
    }

    // Audio
    if (c.hasAudio) {
      const blob = await idbGet(`${kind}-audio`);
      if (blob) {
        if (a.audioUrl) URL.revokeObjectURL(a.audioUrl);
        a.audioUrl = URL.createObjectURL(blob);
        a.audio = new Audio();
        a.audio.src = a.audioUrl;
        a.audio.loop = !!c.audioLoop;
        a.audio.volume = (c.audioVolume != null ? c.audioVolume : 0.6);
        a.audio.preload = 'auto';
      }
    } else {
      if (a.audio) { try { a.audio.pause(); } catch (e) {} }
      if (a.audioUrl) URL.revokeObjectURL(a.audioUrl);
      a.audioUrl = null;
      a.audio = null;
    }
  }

  async function loadAllAssets() {
    await Promise.all([loadAssetsFor('intro'), loadAssetsFor('outro')]);
  }

  // ============ Dessin (appelé par studio.js depuis drawScene) ============
  function draw(ctx, kind, W, H) {
    const c = config[kind];
    const a = assets[kind];

    if (c.mode === 'video' && a.video && a.video.readyState >= 2) {
      // Mode vidéo : cover plein cadre
      if (a.video.paused) a.video.play().catch(() => {});
      const v = a.video;
      const sAR = v.videoWidth / v.videoHeight;
      const dAR = W / H;
      let sx, sy, sw, sh;
      if (sAR > dAR) {
        sh = v.videoHeight;
        sw = sh * dAR;
        sx = (v.videoWidth - sw) / 2;
        sy = 0;
      } else {
        sw = v.videoWidth;
        sh = sw / dAR;
        sx = 0;
        sy = (v.videoHeight - sh) / 2;
      }
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
      return;
    }

    // Mode texte (fallback si vidéo pas prête)
    drawTextScene(ctx, kind, W, H);
  }

  function drawTextScene(ctx, kind, W, H) {
    const c = config[kind];
    const a = assets[kind];

    // Fond gradient
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, c.bgColor || '#1e3a8a');
    grad.addColorStop(1, c.bgColor2 || '#831843');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Particules / léger motif (cercles flottants avec parallax doux)
    drawSubtleBokeh(ctx, W, H, c.accentColor || '#d4af37');

    let cursorY = H / 2;
    const hasLogo = !!a.logo;
    const hasCountdown = kind === 'intro' && !!c.countdownTo;

    // Décaler le bloc texte vers le haut si on a un logo et/ou un countdown en bas
    if (hasLogo) cursorY -= H * 0.10;
    if (hasCountdown) cursorY -= H * 0.05;

    // Logo
    if (hasLogo) {
      const maxW = W * 0.22;
      const maxH = H * 0.22;
      const lw = a.logo.naturalWidth;
      const lh = a.logo.naturalHeight;
      if (lw && lh) {
        const scale = Math.min(maxW / lw, maxH / lh);
        const dw = lw * scale;
        const dh = lh * scale;
        const ly = cursorY - dh - H * 0.04;
        ctx.drawImage(a.logo, (W - dw) / 2, ly, dw, dh);
      }
    }

    // Titre
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.textColor || '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 6;
    ctx.font = `700 ${Math.round(H * 0.10)}px 'Cinzel', Georgia, serif`;
    if (c.title) {
      ctx.fillText(c.title, W / 2, cursorY);
    }

    // Sous-titre
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 4;
    ctx.font = `400 italic ${Math.round(H * 0.035)}px 'Playfair Display', Georgia, serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    if (c.subtitle) {
      ctx.fillText(c.subtitle, W / 2, cursorY + H * 0.09);
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Countdown (intro seulement)
    if (hasCountdown) {
      const remaining = computeRemainingSeconds(c.countdownTo);
      drawCountdown(ctx, remaining, W, H, c.accentColor || '#d4af37');
    }
  }

  function drawSubtleBokeh(ctx, W, H, accent) {
    // Quelques cercles flous animés, opacité faible, juste pour donner du mouvement
    const t = performance.now() / 1000;
    const rgba = hexToRgba(accent, 0.08);
    ctx.fillStyle = rgba;
    const positions = [
      [0.15 + Math.sin(t * 0.3) * 0.05, 0.2 + Math.cos(t * 0.4) * 0.05, 0.18],
      [0.85 + Math.sin(t * 0.25) * 0.04, 0.3 + Math.cos(t * 0.35) * 0.04, 0.15],
      [0.7 + Math.sin(t * 0.4) * 0.05, 0.8 + Math.cos(t * 0.3) * 0.05, 0.22],
      [0.25 + Math.sin(t * 0.5) * 0.04, 0.75 + Math.cos(t * 0.45) * 0.04, 0.16],
      [0.5 + Math.sin(t * 0.2) * 0.03, 0.5 + Math.cos(t * 0.25) * 0.03, 0.25]
    ];
    positions.forEach(([x, y, r]) => {
      ctx.beginPath();
      ctx.arc(x * W, y * H, r * Math.min(W, H), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function computeRemainingSeconds(hhmm) {
    if (!hhmm) return -1;
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    if (isNaN(h) || isNaN(m)) return -1;
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= now.getTime()) {
      // Si l'heure est passée aujourd'hui, on suppose que c'est pour demain
      // mais seulement si l'écart est > 12h (sinon on affiche "Commencé")
      const diff = (target.getTime() + 24 * 3600 * 1000 - now.getTime()) / 1000;
      if (diff < 12 * 3600) return -1; // dans le passé récent → "C'est l'heure"
      return diff;
    }
    return (target.getTime() - now.getTime()) / 1000;
  }

  function drawCountdown(ctx, seconds, W, H, accent) {
    const labelY = H * 0.78;
    const valueY = H * 0.86;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetY = 3;

    if (seconds < 0) {
      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(H * 0.06)}px -apple-system, "Helvetica Neue", sans-serif`;
      ctx.fillText('C\'est l\'heure', W / 2, valueY);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `400 ${Math.round(H * 0.025)}px -apple-system, sans-serif`;
      ctx.fillText('Début dans', W / 2, labelY);

      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const text = h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(H * 0.075)}px 'SF Mono', Menlo, monospace`;
      ctx.fillText(text, W / 2, valueY);
    }

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  function hexToRgba(hex, alpha) {
    const h = (hex || '#000000').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ============ Audio (mixé dans programAudioStream du studio) ============
  let activeAudioKind = null;
  let activeAudioSource = null;
  let activeAudioGain = null;

  function startAudio(kind) {
    stopAudio();
    const a = assets[kind];
    if (!a || !a.audio) return;

    const audioCtx = window.__studioAudio?.audioCtx;
    const audioDest = window.__studioAudio?.audioDest;
    if (!audioCtx || !audioDest) return;

    try {
      activeAudioSource = audioCtx.createMediaElementSource(a.audio);
      activeAudioGain = audioCtx.createGain();
      activeAudioGain.gain.value = (config[kind].audioVolume != null ? config[kind].audioVolume : 0.6);
      activeAudioSource.connect(activeAudioGain).connect(audioDest);
      // Aussi vers la sortie haut-parleur Mac (monitoring)
      activeAudioGain.connect(audioCtx.destination);
    } catch (e) {
      // createMediaElementSource peut échouer si l'élément a déjà été lié → recréer l'audio
      try {
        if (a.audioUrl) {
          a.audio = new Audio(a.audioUrl);
          a.audio.loop = !!config[kind].audioLoop;
          a.audio.volume = (config[kind].audioVolume != null ? config[kind].audioVolume : 0.6);
          activeAudioSource = audioCtx.createMediaElementSource(a.audio);
          activeAudioGain = audioCtx.createGain();
          activeAudioGain.gain.value = config[kind].audioVolume;
          activeAudioSource.connect(activeAudioGain).connect(audioDest);
          activeAudioGain.connect(audioCtx.destination);
        }
      } catch (e2) {
        console.warn('intro-outro audio setup failed', e2);
      }
    }
    a.audio.currentTime = 0;
    a.audio.play().catch(err => console.warn('intro-outro audio play blocked', err));
    activeAudioKind = kind;
  }

  function stopAudio() {
    if (activeAudioKind) {
      const a = assets[activeAudioKind];
      if (a && a.audio) { try { a.audio.pause(); } catch (e) {} }
    }
    if (activeAudioSource) { try { activeAudioSource.disconnect(); } catch (e) {} activeAudioSource = null; }
    if (activeAudioGain) { try { activeAudioGain.disconnect(); } catch (e) {} activeAudioGain = null; }
    activeAudioKind = null;
  }

  function onSceneChange(scene) {
    const kind = (scene && (scene.kind === 'intro' || scene.kind === 'outro')) ? scene.kind : null;
    if (kind && config[kind].hasAudio) {
      if (activeAudioKind !== kind) startAudio(kind);
    } else {
      stopAudio();
    }
    // Reset position vidéo quand on quitte la scène
    if (!kind) {
      ['intro', 'outro'].forEach(k => {
        const v = assets[k].video;
        if (v && !v.paused) { try { v.pause(); v.currentTime = 0; } catch (e) {} }
      });
    }
  }

  function isConfigured(kind) {
    const c = config[kind];
    if (c.mode === 'video') return c.hasVideo;
    // text : toujours utilisable (titre par défaut)
    return true;
  }

  // ============ UI (modal de config) ============
  function $(id) { return document.getElementById(id); }

  function openModal(kind) {
    $('ioModal').classList.add('show');
    switchTab(kind || 'intro');
  }
  function closeModal() {
    $('ioModal').classList.remove('show');
  }

  let currentTab = 'intro';
  function switchTab(kind) {
    currentTab = kind;
    $('ioTabIntro').classList.toggle('active', kind === 'intro');
    $('ioTabOutro').classList.toggle('active', kind === 'outro');
    $('ioPaneIntro').hidden = kind !== 'intro';
    $('ioPaneOutro').hidden = kind !== 'outro';
    renderForm(kind);
  }

  function renderForm(kind) {
    const c = config[kind];
    const prefix = kind === 'intro' ? 'ioIn' : 'ioOut';
    $(`${prefix}Mode${c.mode === 'video' ? 'Video' : 'Text'}`).checked = true;
    $(`${prefix}Title`).value = c.title || '';
    $(`${prefix}Subtitle`).value = c.subtitle || '';
    $(`${prefix}BgColor`).value = c.bgColor || '#1e3a8a';
    $(`${prefix}BgColor2`).value = c.bgColor2 || '#831843';
    $(`${prefix}AccentColor`).value = c.accentColor || '#d4af37';
    $(`${prefix}TextColor`).value = c.textColor || '#ffffff';
    $(`${prefix}AudioVolume`).value = Math.round((c.audioVolume != null ? c.audioVolume : 0.6) * 100);
    $(`${prefix}AudioVolumeVal`).textContent = $(`${prefix}AudioVolume`).value + ' %';
    $(`${prefix}AudioLoop`).checked = !!c.audioLoop;
    if (kind === 'intro') {
      $(`${prefix}Countdown`).value = c.countdownTo || '';
    }
    updateFileLabels(kind);
    updateModeUi(kind);
  }

  function updateFileLabels(kind) {
    const c = config[kind];
    const prefix = kind === 'intro' ? 'ioIn' : 'ioOut';
    $(`${prefix}LogoStatus`).textContent = c.hasLogo ? '✓ Logo importé' : 'Aucun logo';
    $(`${prefix}VideoStatus`).textContent = c.hasVideo ? '✓ Vidéo importée' : 'Aucune vidéo';
    $(`${prefix}AudioStatus`).textContent = c.hasAudio ? '✓ Audio importé' : 'Aucun audio';
    $(`${prefix}LogoRemove`).hidden = !c.hasLogo;
    $(`${prefix}VideoRemove`).hidden = !c.hasVideo;
    $(`${prefix}AudioRemove`).hidden = !c.hasAudio;
  }

  function updateModeUi(kind) {
    const c = config[kind];
    const prefix = kind === 'intro' ? 'ioIn' : 'ioOut';
    const isVideo = c.mode === 'video';
    $(`${prefix}TextOptions`).hidden = isVideo;
    $(`${prefix}VideoOptions`).hidden = !isVideo;
  }

  function readForm(kind) {
    const prefix = kind === 'intro' ? 'ioIn' : 'ioOut';
    const c = config[kind];
    c.mode = $(`${prefix}ModeVideo`).checked ? 'video' : 'text';
    c.title = $(`${prefix}Title`).value;
    c.subtitle = $(`${prefix}Subtitle`).value;
    c.bgColor = $(`${prefix}BgColor`).value;
    c.bgColor2 = $(`${prefix}BgColor2`).value;
    c.accentColor = $(`${prefix}AccentColor`).value;
    c.textColor = $(`${prefix}TextColor`).value;
    c.audioVolume = parseInt($(`${prefix}AudioVolume`).value, 10) / 100;
    c.audioLoop = $(`${prefix}AudioLoop`).checked;
    if (kind === 'intro') c.countdownTo = $(`${prefix}Countdown`).value;
  }

  async function handleFileUpload(kind, slot, file) {
    const key = `${kind}-${slot}`;
    await idbPut(key, file);
    config[kind][slot === 'logo' ? 'hasLogo' : slot === 'video' ? 'hasVideo' : 'hasAudio'] = true;
    saveConfig();
    await loadAssetsFor(kind);
    updateFileLabels(kind);
    notifyChange();
  }

  async function handleFileRemove(kind, slot) {
    const key = `${kind}-${slot}`;
    await idbDel(key);
    config[kind][slot === 'logo' ? 'hasLogo' : slot === 'video' ? 'hasVideo' : 'hasAudio'] = false;
    saveConfig();
    await loadAssetsFor(kind);
    updateFileLabels(kind);
    notifyChange();
  }

  let onChange = () => {};
  function notifyChange() { onChange(); }

  function bindUi() {
    // Ouvrir / fermer
    $('openIntroOutroBtn').addEventListener('click', () => openModal('intro'));
    $('ioModalClose').addEventListener('click', closeModal);
    $('ioModalOk').addEventListener('click', () => {
      readForm(currentTab);
      saveConfig();
      notifyChange();
      closeModal();
    });

    // Tabs
    $('ioTabIntro').addEventListener('click', () => { readForm(currentTab); saveConfig(); switchTab('intro'); });
    $('ioTabOutro').addEventListener('click', () => { readForm(currentTab); saveConfig(); switchTab('outro'); });

    // Form inputs (live save sur input pour les couleurs / volume → preview)
    ['ioIn', 'ioOut'].forEach(prefix => {
      const kind = prefix === 'ioIn' ? 'intro' : 'outro';

      $(`${prefix}ModeText`).addEventListener('change', () => { config[kind].mode = 'text'; saveConfig(); updateModeUi(kind); notifyChange(); });
      $(`${prefix}ModeVideo`).addEventListener('change', () => { config[kind].mode = 'video'; saveConfig(); updateModeUi(kind); notifyChange(); });

      $(`${prefix}Title`).addEventListener('input', (e) => { config[kind].title = e.target.value; saveConfig(); notifyChange(); });
      $(`${prefix}Subtitle`).addEventListener('input', (e) => { config[kind].subtitle = e.target.value; saveConfig(); notifyChange(); });
      $(`${prefix}BgColor`).addEventListener('input', (e) => { config[kind].bgColor = e.target.value; saveConfig(); notifyChange(); });
      $(`${prefix}BgColor2`).addEventListener('input', (e) => { config[kind].bgColor2 = e.target.value; saveConfig(); notifyChange(); });
      $(`${prefix}AccentColor`).addEventListener('input', (e) => { config[kind].accentColor = e.target.value; saveConfig(); notifyChange(); });
      $(`${prefix}TextColor`).addEventListener('input', (e) => { config[kind].textColor = e.target.value; saveConfig(); notifyChange(); });

      const vol = $(`${prefix}AudioVolume`);
      vol.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        $(`${prefix}AudioVolumeVal`).textContent = v + ' %';
        config[kind].audioVolume = v / 100;
        if (activeAudioGain && activeAudioKind === kind) activeAudioGain.gain.value = v / 100;
        saveConfig();
      });
      $(`${prefix}AudioLoop`).addEventListener('change', (e) => {
        config[kind].audioLoop = e.target.checked;
        if (assets[kind].audio) assets[kind].audio.loop = e.target.checked;
        saveConfig();
      });

      if (kind === 'intro') {
        $(`${prefix}Countdown`).addEventListener('input', (e) => { config[kind].countdownTo = e.target.value; saveConfig(); notifyChange(); });
      }

      // Fichiers
      $(`${prefix}LogoInput`).addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        await handleFileUpload(kind, 'logo', f);
      });
      $(`${prefix}VideoInput`).addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        await handleFileUpload(kind, 'video', f);
      });
      $(`${prefix}AudioInput`).addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        await handleFileUpload(kind, 'audio', f);
      });
      $(`${prefix}LogoRemove`).addEventListener('click', () => handleFileRemove(kind, 'logo'));
      $(`${prefix}VideoRemove`).addEventListener('click', () => handleFileRemove(kind, 'video'));
      $(`${prefix}AudioRemove`).addEventListener('click', () => handleFileRemove(kind, 'audio'));
    });
  }

  // ============ Exposition publique ============
  window.IntroOutro = {
    async init(opts) {
      onChange = opts?.onChange || (() => {});
      await loadAllAssets();
      bindUi();
    },
    draw,
    onSceneChange,
    isConfigured,
    getConfig: () => config
  };
})();
