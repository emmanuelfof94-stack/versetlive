// Page d'affichage pour OBS Studio
// Reçoit les ordres du panneau de contrôle via BroadcastChannel + localStorage

const CHANNEL_NAME = 'versetlive';
const STORAGE_KEY = 'versetlive:state';

const stage = document.getElementById('stage');
const content = document.getElementById('content');
const verseTextEl = document.getElementById('verseText');
const refTopEl = document.getElementById('refTop');
const refBottomEl = document.getElementById('refBottom');
const bgLayer = document.getElementById('bgLayer');
const titleContent = document.getElementById('titleContent');
const titleMainEl = document.getElementById('titleMainEl');
const titleSubEl = document.getElementById('titleSubEl');

const TITLE_TEMPLATE_IDS = ['classic','elegant','banner','modern','card','double','ornament','minimal','lower-third','badge'];

const isPreview = new URLSearchParams(window.location.search).get('preview') === '1';
if (isPreview) document.body.classList.add('preview-mode');

let currentState = null;

function applyStyle(style) {
  const s = style || {};
  // Alignement vertical
  stage.classList.remove('v-top', 'v-center', 'v-bottom');
  if (s.vAlign === 'top') stage.classList.add('v-top');
  else if (s.vAlign === 'bottom') stage.classList.add('v-bottom');

  // Animation
  stage.classList.remove('anim-fade', 'anim-slide-up', 'anim-zoom', 'anim-none');
  stage.classList.add('anim-' + (s.animation || 'fade'));

  // Ombres
  stage.classList.remove('shadow-none', 'shadow-soft', 'shadow-strong', 'shadow-outline', 'shadow-glow');
  stage.classList.add('shadow-' + (s.textShadow || 'soft'));

  // Texte
  verseTextEl.style.fontFamily = s.fontFamily || 'Georgia, serif';
  verseTextEl.style.color = s.textColor || '#ffffff';
  verseTextEl.style.fontSize = (s.fontSize || 4.5) + 'vw';
  verseTextEl.style.textAlign = s.textAlign || 'center';

  refTopEl.style.fontFamily = s.fontFamily || 'Georgia, serif';
  refBottomEl.style.fontFamily = s.fontFamily || 'Georgia, serif';
  refTopEl.style.color = s.textColor || '#ffffff';
  refBottomEl.style.color = s.textColor || '#ffffff';
  const refSize = Math.max(1.4, (s.fontSize || 4.5) * 0.5);
  refTopEl.style.fontSize = refSize + 'vw';
  refBottomEl.style.fontSize = refSize + 'vw';

  // Position référence
  const refPos = s.showRef || 'below';
  refTopEl.style.display = refPos === 'above' ? 'block' : 'none';
  refBottomEl.style.display = refPos === 'below' ? 'block' : 'none';

  // Arrière-plan
  const bgType = s.bgType || 'transparent';
  const bgColor = s.bgColor || '#000000';
  const bgOpacity = s.bgOpacity != null ? s.bgOpacity : 0.5;

  if (bgType === 'transparent') {
    bgLayer.classList.remove('show');
    bgLayer.style.background = 'transparent';
  } else if (bgType === 'solid') {
    bgLayer.style.background = hexWithAlpha(bgColor, bgOpacity);
    bgLayer.classList.add('show');
  } else if (bgType === 'gradient') {
    bgLayer.style.background = `linear-gradient(135deg, ${hexWithAlpha(bgColor, bgOpacity)}, ${hexWithAlpha(shadeColor(bgColor, -30), bgOpacity)})`;
    bgLayer.classList.add('show');
  } else if (bgType === 'overlay') {
    // Bandeau central translucide
    bgLayer.style.background = 'transparent';
    bgLayer.classList.remove('show');
    // On applique sur le content
  }

  // Bandeau translucide derrière le texte
  if (bgType === 'overlay') {
    content.style.background = hexWithAlpha(bgColor, bgOpacity);
    content.style.padding = '4vh 4vw';
    content.style.borderRadius = '12px';
    content.style.backdropFilter = 'blur(4px)';
  } else {
    content.style.background = '';
    content.style.padding = '';
    content.style.borderRadius = '';
    content.style.backdropFilter = '';
  }
}

function hexWithAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function shadeColor(hex, percent) {
  const h = hex.replace('#', '');
  let r = parseInt(h.substring(0, 2), 16);
  let g = parseInt(h.substring(2, 4), 16);
  let b = parseInt(h.substring(4, 6), 16);
  r = Math.max(0, Math.min(255, r + percent));
  g = Math.max(0, Math.min(255, g + percent));
  b = Math.max(0, Math.min(255, b + percent));
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function showVerse(state) {
  currentState = state;
  applyStyle(state.style || {});

  // Cacher le titre s'il était visible
  titleContent.classList.remove('visible', 'active');

  if (!state.text) {
    content.classList.remove('visible');
    return;
  }

  // Réinitialise pour relancer l'animation
  content.classList.remove('visible');
  verseTextEl.textContent = '« ' + state.text.trim() + ' »';
  const ref = state.reference || '';
  refTopEl.textContent = ref;
  refBottomEl.textContent = ref;

  // Force reflow puis affiche
  void content.offsetWidth;
  requestAnimationFrame(() => content.classList.add('visible'));
}

function clearVerse() {
  content.classList.remove('visible');
  titleContent.classList.remove('visible');
  setTimeout(() => {
    verseTextEl.textContent = '';
    refTopEl.textContent = '';
    refBottomEl.textContent = '';
    titleContent.classList.remove('active');
    titleMainEl.textContent = '';
    titleSubEl.textContent = '';
  }, 500);
}

function showTitle(payload) {
  const p = payload || {};
  applyStyle(p.style || {});

  // Cacher le contenu verset et activer le contenu titre
  content.classList.remove('visible');

  // Réinitialiser les classes de modèle
  TITLE_TEMPLATE_IDS.forEach(id => titleContent.classList.remove('title-tpl-' + id));
  const tpl = TITLE_TEMPLATE_IDS.includes(p.template) ? p.template : 'classic';
  titleContent.classList.add('title-tpl-' + tpl);

  // Couleur d'accent
  titleContent.style.setProperty('--accent', p.accent || '#d4af37');

  // Texte
  titleMainEl.textContent = p.title || '';
  titleSubEl.textContent = p.subtitle || '';

  // Afficher
  titleContent.classList.add('active');
  titleContent.classList.remove('visible');
  void titleContent.offsetWidth;
  requestAnimationFrame(() => titleContent.classList.add('visible'));
}

function restoreInitialState(state) {
  if (!state) return;
  if (state.kind === 'title' && state.title) showTitle(state);
  else if (state.text) showVerse(state);
  else applyStyle(state.style || {});
}

// Charger état initial depuis localStorage
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) restoreInitialState(JSON.parse(saved));
} catch (e) { console.warn('État initial invalide', e); }

function handleMessage(msg) {
  if (!msg) return;
  if (msg.type === 'show') showVerse(msg.payload);
  else if (msg.type === 'showTitle') showTitle(msg.payload);
  else if (msg.type === 'clear') clearVerse();
  else if (msg.type === 'style') applyStyle(msg.payload);
}

// Écouter changements via BroadcastChannel (même origine)
let bc = null;
try {
  bc = new BroadcastChannel(CHANNEL_NAME);
  bc.addEventListener('message', (event) => handleMessage(event.data));
} catch (e) { console.warn('BroadcastChannel indisponible', e); }

// Canal direct depuis la fenêtre parente (utilisé pour l'iframe d'aperçu,
// où BroadcastChannel/storage events ne passent pas toujours, notamment en file://)
window.addEventListener('message', (event) => handleMessage(event.data));

// Fallback : storage events (pour différents domaines / iframes)
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  try {
    const state = JSON.parse(e.newValue);
    if (state.kind === 'title' && state.title) showTitle(state);
    else if (state.text) showVerse(state);
    else { applyStyle(state.style || {}); clearVerse(); }
  } catch (err) { /* ignore */ }
});
