// Panneau de contrôle VersetLive

const CHANNEL_NAME = 'versetlive';
const STORAGE_KEY = 'versetlive:state';
const STYLE_KEY = 'versetlive:style';
const HISTORY_KEY = 'versetlive:history';

const bc = (() => { try { return new BroadcastChannel(CHANNEL_NAME); } catch { return null; } })();

// Charge un chapitre par (livre, chapitre) et place activeIndex sur le
// verset demandé (1-indexé, ou dernier verset si verseNum === 'last').
// Utilisé par la nav cross-chapitre du studio.
async function loadChapterAt(book, chap, verseNum) {
  const verses = await fetchChapter(currentTranslation, book.id, chap);
  if (!verses || !verses.length) throw new Error('Chapitre vide');
  chapterVerses = verses.map(vx => ({
    num: vx.verse,
    text: cleanVerseHtml(vx.text),
    reference: `${book.name} ${chap}:${vx.verse}`,
  }));
  currentBookName = book.name;
  currentChapter = chap;
  if (verseNum === 'last') activeIndex = chapterVerses.length - 1;
  else activeIndex = chapterVerses.findIndex(cv => cv.num === verseNum);
  if (activeIndex < 0) activeIndex = 0;
  // Synchroniser les sélecteurs du panneau si présents.
  if (els.book) els.book.value = book.id;
  if (els.chapter) {
    els.chapter.innerHTML = Array.from({ length: book.chapters }, (_, i) =>
      `<option value="${i + 1}">${i + 1}</option>`
    ).join('');
    els.chapter.value = chap;
  }
  renderVerseList();
}

// ====== RÉFÉRENCES ET PLAGES DE VERSETS ======
// Un seul parseur pour TOUS les endroits où l'on tape une référence (barre du
// Studio, recherche du panneau). Accepte, avec ou sans espaces :
//   « Luc 2 »            → chapitre entier, verset 1
//   « Luc 2:5 », « Luc 2. 5 »
//   « Luc 2: 1-10 », « 1 Jean 4 : 7 – 12 »  → plage de versets
// Les tirets typographiques (– —) sont normalisés en tiret simple.
function parseVerseRef(input) {
  const s = String(input || '').trim().replace(/[–—]/g, '-');
  // Livre = éventuel chiffre initial (1 Jean) + lettres/espaces/points.
  // Le quantificateur paresseux laisse les chiffres suivants au chapitre.
  const m = s.match(/^(\d?\s*[A-Za-zÀ-ÖØ-öø-ÿ.\s]+?)\s*(\d+)\s*(?:[:.,]\s*(\d+)\s*(?:-\s*(\d+))?)?\s*$/);
  if (!m) return null;
  const bookName = m[1].trim().replace(/\.$/, '').toLowerCase();
  const chap = parseInt(m[2], 10);
  const start = m[3] ? parseInt(m[3], 10) : null;
  let end = m[4] ? parseInt(m[4], 10) : start;
  if (start && end && end < start) end = start; // « 10-1 » → verset 10 seul
  const book = BIBLE_BOOKS.find(b =>
    b.name.toLowerCase() === bookName ||
    b.name.toLowerCase().startsWith(bookName) ||
    b.short.toLowerCase() === bookName
  );
  if (!book) return { error: 'book-not-found' };
  if (chap < 1 || chap > book.chapters) return { error: 'chapter-out-of-range' };
  return { book, chap, start, end, isRange: !!(start && end && end > start) };
}

// ====== PLAGE DIFFUSÉE EN PAGES ======
// Une plage longue (Luc 2:1-10 ≈ 1200 caractères) serait illisible d'un bloc :
// l'auto-réduction du studio descendrait à 14 px. On découpe donc la plage en
// « écrans » qui tiennent lisiblement, et Suivant/Précédent fait défiler ces
// écrans (au lieu d'avancer verset par verset) tant que la plage est active.
const RANGE_PAGE_MAX_CHARS = 320; // ≈ 4 lignes à la taille par défaut

// verseRange = { bookName, chap, startNum, endNum, pages: [...], index }
// pages[i] = { reference, text, startNum, endNum }
let verseRange = null;

// Découpage glouton : on remplit un écran tant qu'on reste sous le budget de
// caractères, avec toujours AU MOINS un verset par écran (un verset très long
// occupe son propre écran et sera réduit par le studio).
function buildVersePages(bookName, chap, verses) {
  const pages = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    const a = cur[0].num, b = cur[cur.length - 1].num;
    pages.push({
      reference: `${bookName} ${chap}:${a === b ? a : a + '-' + b}`,
      // Numéros de verset en préfixe : indispensable dès qu'un écran en contient
      // plusieurs, et cohérent quand la plage se réduit à un seul.
      text: cur.map(v => `${v.num}. ${v.text}`).join(' '),
      startNum: a,
      endNum: b,
    });
    cur = [];
    curLen = 0;
  };
  verses.forEach(v => {
    const piece = `${v.num}. ${v.text}`;
    if (cur.length && curLen + piece.length + 1 > RANGE_PAGE_MAX_CHARS) flush();
    cur.push(v);
    curLen += piece.length + 1;
  });
  flush();
  return pages;
}

// Diffuse l'écran i de la plage active.
function sendRangePage(i) {
  if (!verseRange) return;
  const n = verseRange.pages.length;
  const idx = Math.max(0, Math.min(n - 1, i));
  verseRange.index = idx;
  const p = verseRange.pages[idx];
  // Aligner la sélection de la liste sur le premier verset de l'écran : si l'on
  // quitte la plage (Suivant en fin de plage), la navigation reprend au bon endroit.
  const listIdx = chapterVerses.findIndex(cv => cv.num === p.startNum);
  if (listIdx >= 0) activeIndex = listIdx;
  highlightRangeInList();
  broadcastVerse(p.reference, p.text, undefined, {
    rangeRef: `${verseRange.bookName} ${verseRange.chap}:${verseRange.startNum}-${verseRange.endNum}`,
    pageIndex: idx + 1,
    pageCount: n,
  });
}

// Prépare une plage à partir du chapitre déjà chargé (sélection Maj+clic), sans
// la diffuser : l'opérateur envoie ensuite avec « Envoyer en direct ».
function setRangeFromList(iStart, iEnd) {
  const a = Math.min(iStart, iEnd), b = Math.max(iStart, iEnd);
  const slice = chapterVerses.slice(a, b + 1);
  if (!slice.length) return;
  verseRange = {
    bookName: currentBookName,
    chap: currentChapter,
    startNum: slice[0].num,
    endNum: slice[slice.length - 1].num,
    pages: buildVersePages(currentBookName, currentChapter, slice),
    index: 0,
  };
  highlightRangeInList();
  const n = verseRange.pages.length;
  els.currentRef.textContent =
    `${verseRange.bookName} ${verseRange.chap}:${verseRange.startNum}-${verseRange.endNum}`
    + ` — ${slice.length} versets, ${n} écran${n > 1 ? 's' : ''} (sélectionné)`;
}

// Charge un chapitre puis diffuse la plage demandée (référence tapée).
async function showVerseRange(book, chap, start, end) {
  const verses = await fetchChapter(currentTranslation, book.id, chap);
  if (!verses || !verses.length) throw new Error('Chapitre vide');
  chapterVerses = verses.map(vx => ({
    num: vx.verse,
    text: cleanVerseHtml(vx.text),
    reference: `${book.name} ${chap}:${vx.verse}`,
  }));
  currentBookName = book.name;
  currentChapter = chap;
  if (els.book) els.book.value = book.id;
  if (els.chapter) {
    els.chapter.innerHTML = Array.from({ length: book.chapters }, (_, i) =>
      `<option value="${i + 1}">${i + 1}</option>`
    ).join('');
    els.chapter.value = chap;
  }
  renderVerseList();

  const inRange = chapterVerses.filter(v => v.num >= start && v.num <= end);
  if (!inRange.length) throw new Error('Versets hors du chapitre');
  verseRange = {
    bookName: book.name,
    chap,
    startNum: inRange[0].num,
    endNum: inRange[inRange.length - 1].num,
    pages: buildVersePages(book.name, chap, inRange),
    index: 0,
  };
  sendRangePage(0);
}

// Surligne dans la liste tous les versets de la plage active.
function highlightRangeInList() {
  if (!els.verseList) return;
  const items = els.verseList.querySelectorAll('.verse-item');
  items.forEach((el, j) => {
    const v = chapterVerses[j];
    const inRange = verseRange && v && v.num >= verseRange.startNum && v.num <= verseRange.endNum;
    el.classList.toggle('in-range', !!inRange);
    el.classList.toggle('active', j === activeIndex);
  });
}

// Sort du mode plage (retour au verset par verset).
function clearVerseRange() {
  if (!verseRange) return;
  verseRange = null;
  if (els.verseList) {
    els.verseList.querySelectorAll('.verse-item').forEach(el => el.classList.remove('in-range'));
  }
}

// Reçoit les commandes de navigation envoyées par le studio (sans
// devoir revenir manuellement sur cet onglet). Le studio envoie
// { type: 'nav', action: 'prev'|'next'|'clear'|'showRef', payload? }.
bc?.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg) return;
  // Style modifié ailleurs (studio) : on resynchronise les contrôles pour que
  // getStyle() reste à jour et n'écrase pas ces réglages au prochain changement
  // local. On ne rediffuse pas (les autres surfaces ont déjà reçu le message).
  if (msg.type === 'style' && msg.payload) {
    applyStyleToControls(msg.payload);
    return;
  }
  if (msg.type !== 'nav') return;

  // Plage active : Suivant/Précédent fait défiler les écrans de la plage. Aux
  // bornes, on quitte la plage et la navigation verset par verset reprend là où
  // la plage s'arrêtait (sendRangePage a déjà calé activeIndex).
  if (verseRange && (msg.action === 'next' || msg.action === 'prev')) {
    if (msg.action === 'next' && verseRange.index < verseRange.pages.length - 1) {
      sendRangePage(verseRange.index + 1);
      return;
    }
    if (msg.action === 'prev' && verseRange.index > 0) {
      sendRangePage(verseRange.index - 1);
      return;
    }
    // Sortie de plage : se positionner sur le dernier (Suivant) ou le premier
    // (Précédent) verset de la plage, puis laisser la logique normale continuer.
    const boundaryNum = msg.action === 'next' ? verseRange.endNum : verseRange.startNum;
    const idx = chapterVerses.findIndex(cv => cv.num === boundaryNum);
    if (idx >= 0) activeIndex = idx;
    clearVerseRange();
  }

  if (msg.action === 'next') {
    if (activeIndex < chapterVerses.length - 1) {
      selectVerse(activeIndex + 1);
      sendCurrentVerse();
    } else {
      // Cross-chapitre : aller au verset 1 du chapitre suivant.
      // Cross-livre si on est au dernier chapitre du livre courant.
      const curBook = BIBLE_BOOKS.find(b => b.name === currentBookName);
      if (!curBook) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'end-of-chapter' }); return; }
      let nextBook = curBook;
      let nextChap = currentChapter + 1;
      if (nextChap > curBook.chapters) {
        nextBook = BIBLE_BOOKS.find(b => b.id === curBook.id + 1);
        if (!nextBook) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'end-of-bible' }); return; }
        nextChap = 1;
      }
      try {
        await loadChapterAt(nextBook, nextChap, 1);
        sendCurrentVerse();
      } catch (e) {
        bc?.postMessage({ type: 'navAck', ok: false, reason: 'fetch-' + (e.message || 'error') });
      }
    }
  } else if (msg.action === 'prev') {
    if (activeIndex > 0) {
      selectVerse(activeIndex - 1);
      sendCurrentVerse();
    } else {
      // Cross-chapitre : aller au dernier verset du chapitre précédent.
      const curBook = BIBLE_BOOKS.find(b => b.name === currentBookName);
      if (!curBook) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'start-of-chapter' }); return; }
      let prevBook = curBook;
      let prevChap = currentChapter - 1;
      if (prevChap < 1) {
        prevBook = BIBLE_BOOKS.find(b => b.id === curBook.id - 1);
        if (!prevBook) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'start-of-bible' }); return; }
        prevChap = prevBook.chapters;
      }
      try {
        await loadChapterAt(prevBook, prevChap, 'last');
        sendCurrentVerse();
      } catch (e) {
        bc?.postMessage({ type: 'navAck', ok: false, reason: 'fetch-' + (e.message || 'error') });
      }
    }
  } else if (msg.action === 'clear') {
    clearLive();
  } else if (msg.action === 'showRef' && msg.payload) {
    // Accepte désormais les plages : « Luc 2:1-10 », « Luc 2: 1 - 10 »…
    const parsed = parseVerseRef(msg.payload);
    if (!parsed) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'parse' }); return; }
    if (parsed.error) { bc?.postMessage({ type: 'navAck', ok: false, reason: parsed.error }); return; }
    try {
      if (parsed.isRange) {
        await showVerseRange(parsed.book, parsed.chap, parsed.start, parsed.end);
      } else {
        clearVerseRange();
        await loadChapterAt(parsed.book, parsed.chap, parsed.start || 1);
        sendCurrentVerse();
      }
    } catch (e) {
      bc?.postMessage({ type: 'navAck', ok: false, reason: 'fetch-' + (e.message || 'error') });
    }
  }
});

// Canal direct vers l'iframe d'aperçu : BroadcastChannel ne traverse pas toujours
// les iframes (notamment en file://). postMessage est garanti même origine.
function postToPreview(msg) {
  const iframe = document.getElementById('previewFrame');
  iframe?.contentWindow?.postMessage(msg, '*');
}

const els = {
  translation: document.getElementById('translationSelect'),
  book: document.getElementById('bookSelect'),
  chapter: document.getElementById('chapterSelect'),
  verseList: document.getElementById('verseList'),
  loadChapterBtn: document.getElementById('loadChapterBtn'),

  searchInput: document.getElementById('searchInput'),
  searchBtn: document.getElementById('searchBtn'),
  searchResults: document.getElementById('searchResults'),

  manualRef: document.getElementById('manualRef'),
  manualText: document.getElementById('manualText'),
  manualSendBtn: document.getElementById('manualSendBtn'),

  currentRef: document.getElementById('currentRef'),
  currentTrans: document.getElementById('currentTrans'),
  prevBtn: document.getElementById('prevVerseBtn'),
  nextBtn: document.getElementById('nextVerseBtn'),
  sendLiveBtn: document.getElementById('sendLiveBtn'),
  clearLiveBtn: document.getElementById('clearLiveBtn'),

  liveDot: document.getElementById('liveDot'),
  liveStatus: document.getElementById('liveStatus'),
  expandBtn: document.getElementById('expandBtn'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),

  historyList: document.getElementById('historyList'),
  toast: document.getElementById('toast'),

  fontFamily: document.getElementById('fontFamily'),
  fontSize: document.getElementById('fontSize'),
  fontSizeVal: document.getElementById('fontSizeVal'),
  textColor: document.getElementById('textColor'),
  textColorHex: document.getElementById('textColorHex'),
  textShadow: document.getElementById('textShadow'),
  textAlign: document.getElementById('textAlign'),
  bgType: document.getElementById('bgType'),
  bgColor: document.getElementById('bgColor'),
  bgColorHex: document.getElementById('bgColorHex'),
  bgOpacity: document.getElementById('bgOpacity'),
  bgOpacityVal: document.getElementById('bgOpacityVal'),
  bgImageInput: document.getElementById('bgImageInput'),
  bgImagePreview: document.getElementById('bgImagePreview'),
  bgImagePreviewField: document.getElementById('bgImagePreviewField'),
  bgImageClearBtn: document.getElementById('bgImageClearBtn'),
  bgImageDim: document.getElementById('bgImageDim'),
  bgImageDimVal: document.getElementById('bgImageDimVal'),
  bgImageDimField: document.getElementById('bgImageDimField'),
  bgImageFit: document.getElementById('bgImageFit'),
  bgImageFitField: document.getElementById('bgImageFitField'),
  bgImageScale: document.getElementById('bgImageScale'),
  bgImageScaleVal: document.getElementById('bgImageScaleVal'),
  bgImageScaleField: document.getElementById('bgImageScaleField'),
  bgImageScaleReset: document.getElementById('bgImageScaleReset'),
  sceneScale: document.getElementById('sceneScale'),
  sceneScaleVal: document.getElementById('sceneScaleVal'),
  sceneScaleReset: document.getElementById('sceneScaleReset'),
  sceneOffsetX: document.getElementById('sceneOffsetX'),
  sceneOffsetXVal: document.getElementById('sceneOffsetXVal'),
  sceneOffsetXReset: document.getElementById('sceneOffsetXReset'),
  sceneOffsetY: document.getElementById('sceneOffsetY'),
  sceneOffsetYVal: document.getElementById('sceneOffsetYVal'),
  sceneOffsetYReset: document.getElementById('sceneOffsetYReset'),
  bgImageOffsetX: document.getElementById('bgImageOffsetX'),
  bgImageOffsetXVal: document.getElementById('bgImageOffsetXVal'),
  bgImageOffsetXReset: document.getElementById('bgImageOffsetXReset'),
  bgImageOffsetXField: document.getElementById('bgImageOffsetXField'),
  bgImageOffsetY: document.getElementById('bgImageOffsetY'),
  bgImageOffsetYVal: document.getElementById('bgImageOffsetYVal'),
  bgImageOffsetYReset: document.getElementById('bgImageOffsetYReset'),
  bgImageOffsetYField: document.getElementById('bgImageOffsetYField'),
  textOffsetX: document.getElementById('textOffsetX'),
  textOffsetXVal: document.getElementById('textOffsetXVal'),
  textOffsetXReset: document.getElementById('textOffsetXReset'),
  textOffsetY: document.getElementById('textOffsetY'),
  textOffsetYVal: document.getElementById('textOffsetYVal'),
  textOffsetYReset: document.getElementById('textOffsetYReset'),
  vAlign: document.getElementById('vAlign'),
  showRef: document.getElementById('showRef'),
  animation: document.getElementById('animation'),
};

let chapterVerses = [];
let activeIndex = -1;
let currentBookName = '';
let currentChapter = 1;
let currentTranslation = 'FRLSG';

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

// Image de fond optionnelle : dataURL (généralement JPEG compressé ≤ 1080p). Stockée
// dans le style pour que tous les receveurs (obs.html, tv.html via PeerJS, studio
// si verseState.style.bgImage est lu) la reçoivent inline.
let bgImageDataUrl = null;

function getStyle() {
  return {
    fontFamily: els.fontFamily.value,
    fontSize: parseFloat(els.fontSize.value),
    textColor: els.textColor.value,
    textShadow: els.textShadow.value,
    textAlign: els.textAlign.value,
    bgType: els.bgType.value,
    bgColor: els.bgColor.value,
    bgOpacity: parseFloat(els.bgOpacity.value),
    bgImage: bgImageDataUrl,
    bgImageDim: parseFloat(els.bgImageDim.value),
    bgImageFit: els.bgImageFit.value,
    bgImageScale: parseFloat(els.bgImageScale.value),
    sceneScale: parseFloat(els.sceneScale.value),
    sceneOffsetX: parseFloat(els.sceneOffsetX.value),
    sceneOffsetY: parseFloat(els.sceneOffsetY.value),
    bgImageOffsetX: parseFloat(els.bgImageOffsetX.value),
    bgImageOffsetY: parseFloat(els.bgImageOffsetY.value),
    textOffsetX: parseFloat(els.textOffsetX.value),
    textOffsetY: parseFloat(els.textOffsetY.value),
    vAlign: els.vAlign.value,
    showRef: els.showRef.value,
    animation: els.animation.value,
  };
}

function persistStyle() {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(getStyle()));
  } catch (e) {
    // QuotaExceededError typique quand l'image de fond est trop grosse :
    // on enregistre alors le style sans l'image (l'image continue à diffuser
    // via BroadcastChannel mais ne survivra pas à un reload).
    if (e && e.name === 'QuotaExceededError' && bgImageDataUrl) {
      try {
        const slim = { ...getStyle(), bgImage: null };
        localStorage.setItem(STYLE_KEY, JSON.stringify(slim));
        toast('Image trop volumineuse pour le stockage local — elle ne survivra pas à un rechargement.');
      } catch (e2) { console.warn('persistStyle fallback failed', e2); }
    } else {
      console.warn('persistStyle failed', e);
    }
  }
}

// Applique un objet style aux contrôles du panneau (sans rien rediffuser).
// Utilisé au démarrage (restoreStyle) et à la réception d'un style modifié
// ailleurs (studio), pour que getStyle() reste à jour et n'écrase pas ces
// réglages au prochain changement local. Ne pas écraser un curseur en cours
// de manipulation par l'utilisateur.
function applyStyleToControls(s) {
  if (!s) return;
  const busy = (el) => document.activeElement === el;
  if (s.fontFamily) els.fontFamily.value = s.fontFamily;
  if (s.fontSize != null && !busy(els.fontSize)) els.fontSize.value = s.fontSize;
  if (s.textColor) { els.textColor.value = s.textColor; els.textColorHex.value = s.textColor; }
  if (s.textShadow) els.textShadow.value = s.textShadow;
  if (s.textAlign) els.textAlign.value = s.textAlign;
  if (s.bgType) els.bgType.value = s.bgType;
  if (s.bgColor) { els.bgColor.value = s.bgColor; els.bgColorHex.value = s.bgColor; }
  if (s.bgOpacity != null && !busy(els.bgOpacity)) els.bgOpacity.value = s.bgOpacity;
  if (s.bgImage !== undefined) bgImageDataUrl = s.bgImage || null;
  if (s.bgImageDim != null && !busy(els.bgImageDim)) els.bgImageDim.value = s.bgImageDim;
  if (s.bgImageFit) els.bgImageFit.value = s.bgImageFit;
  if (s.bgImageScale != null && !busy(els.bgImageScale)) els.bgImageScale.value = s.bgImageScale;
  if (s.sceneScale != null && !busy(els.sceneScale)) els.sceneScale.value = s.sceneScale;
  if (s.sceneOffsetX != null && !busy(els.sceneOffsetX)) els.sceneOffsetX.value = s.sceneOffsetX;
  if (s.sceneOffsetY != null && !busy(els.sceneOffsetY)) els.sceneOffsetY.value = s.sceneOffsetY;
  if (s.bgImageOffsetX != null && !busy(els.bgImageOffsetX)) els.bgImageOffsetX.value = s.bgImageOffsetX;
  if (s.bgImageOffsetY != null && !busy(els.bgImageOffsetY)) els.bgImageOffsetY.value = s.bgImageOffsetY;
  if (s.textOffsetX != null && !busy(els.textOffsetX)) els.textOffsetX.value = s.textOffsetX;
  if (s.textOffsetY != null && !busy(els.textOffsetY)) els.textOffsetY.value = s.textOffsetY;
  if (s.vAlign) els.vAlign.value = s.vAlign;
  if (s.showRef) els.showRef.value = s.showRef;
  if (s.animation) els.animation.value = s.animation;
  refreshRangeLabels();
  updateBgImageUi();
}

function restoreStyle() {
  try {
    const s = JSON.parse(localStorage.getItem(STYLE_KEY) || 'null');
    applyStyleToControls(s);
  } catch {}
}

function refreshRangeLabels() {
  els.fontSizeVal.textContent = parseFloat(els.fontSize.value).toFixed(1);
  els.bgOpacityVal.textContent = parseFloat(els.bgOpacity.value).toFixed(2);
  if (els.bgImageDimVal) els.bgImageDimVal.textContent = parseFloat(els.bgImageDim.value).toFixed(2);
  if (els.bgImageScaleVal) els.bgImageScaleVal.textContent = Math.round(parseFloat(els.bgImageScale.value) * 100) + '%';
  if (els.sceneScaleVal) els.sceneScaleVal.textContent = Math.round(parseFloat(els.sceneScale.value) * 100) + '%';
  if (els.sceneOffsetXVal) els.sceneOffsetXVal.textContent = Math.round(parseFloat(els.sceneOffsetX.value) * 200) + '%';
  if (els.sceneOffsetYVal) els.sceneOffsetYVal.textContent = Math.round(parseFloat(els.sceneOffsetY.value) * 200) + '%';
  if (els.bgImageOffsetXVal) els.bgImageOffsetXVal.textContent = Math.round(parseFloat(els.bgImageOffsetX.value) * 200) + '%';
  if (els.bgImageOffsetYVal) els.bgImageOffsetYVal.textContent = Math.round(parseFloat(els.bgImageOffsetY.value) * 200) + '%';
  if (els.textOffsetXVal) els.textOffsetXVal.textContent = Math.round(parseFloat(els.textOffsetX.value) * 200) + '%';
  if (els.textOffsetYVal) els.textOffsetYVal.textContent = Math.round(parseFloat(els.textOffsetY.value) * 200) + '%';
}

// ===== Image de fond =====
// Compresse en JPEG ≤ 1920×1080 q=0.85 pour rester sous le quota localStorage
// (≈ 5-10 Mo selon navigateur) et garder le broadcast/PeerJS rapide.
async function loadAndCompressImage(file, maxW = 1920, maxH = 1080, quality = 0.85) {
  const rawDataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('Lecture fichier impossible'));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Image illisible'));
    i.src = rawDataUrl;
  });
  // Si l'image rentre dans les bornes et est déjà légère, on garde tel quel
  // (préserve la transparence PNG le cas échéant).
  if (img.naturalWidth <= maxW && img.naturalHeight <= maxH && file.size < 600_000) {
    return rawDataUrl;
  }
  const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  const w = Math.max(1, Math.round(img.naturalWidth * ratio));
  const h = Math.max(1, Math.round(img.naturalHeight * ratio));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

function updateBgImageUi() {
  const has = !!bgImageDataUrl;
  if (has) els.bgImagePreview.src = bgImageDataUrl;
  else els.bgImagePreview.removeAttribute('src');
  els.bgImagePreviewField.style.display = has ? '' : 'none';
  els.bgImageDimField.style.display = has ? '' : 'none';
  els.bgImageFitField.style.display = has ? '' : 'none';
  els.bgImageScaleField.style.display = has ? '' : 'none';
  els.bgImageOffsetXField.style.display = has ? '' : 'none';
  els.bgImageOffsetYField.style.display = has ? '' : 'none';
}

function broadcastStyleOnly() {
  persistStyle();
  const last = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  const payload = { ...(last || {}), style: getStyle() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  bc?.postMessage({ type: 'style', payload: getStyle() });
  postToPreview({ type: 'style', payload: getStyle() });
}

// meta (optionnel) : pour les chants, porte les métadonnées de navigation
//   { kind: 'song', songId, songTitle, songNumber, sectionIndex, totalSections,
//     sectionLabel, sectionType }
// Le studio (et plus tard les co-pilots) utilisent ces champs pour afficher
// un panneau « 🎵 Chant actif » avec ses propres contrôles ◀/▶ Section.
function broadcastVerse(reference, text, translation, meta) {
  const state = {
    reference,
    text,
    translation: translation || currentTranslation,
    style: getStyle(),
    ts: Date.now(),
    ...(meta || {}),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  bc?.postMessage({ type: 'show', payload: state });
  postToPreview({ type: 'show', payload: state });

  // En mode plage, on indique quel écran est à l'antenne (l'écran de projection
  // n'affiche que la référence de l'écran courant, ex. « Luc 2:1-2 »).
  els.currentRef.textContent = (state.pageCount > 1)
    ? `${reference} — écran ${state.pageIndex}/${state.pageCount}`
    : (reference || '—');
  els.currentTrans.textContent = state.translation;
  els.liveDot.classList.add('live');
  els.liveStatus.textContent = 'En direct';
  addToHistory(state);
  toast('Diffusion en cours : ' + reference);
}

function clearLive() {
  clearVerseRange(); // effacer l'écran sort aussi du mode plage
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ style: getStyle() }));
  bc?.postMessage({ type: 'clear' });
  postToPreview({ type: 'clear' });
  els.liveDot.classList.remove('live');
  els.liveStatus.textContent = 'En attente';
  els.currentRef.textContent = '—';
  els.currentTrans.textContent = '';
  toast('Écran effacé');
}

function addToHistory(state) {
  if (!state.text) return;
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch {}
  history = history.filter(h => h.reference !== state.reference);
  history.unshift({ reference: state.reference, text: state.text, translation: state.translation });
  history = history.slice(0, 20);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch {}
  if (!history.length) {
    els.historyList.innerHTML = '<div class="empty">Aucun verset diffusé</div>';
    return;
  }
  els.historyList.innerHTML = history.map((h, i) => `
    <div class="slide-item" data-i="${i}">
      <div style="flex:1; overflow:hidden;">
        <div class="slide-item-ref">${escapeHtml(h.reference)}</div>
        <div class="slide-item-text">${escapeHtml(h.text.substring(0, 60))}${h.text.length > 60 ? '…' : ''}</div>
      </div>
    </div>
  `).join('');
  els.historyList.querySelectorAll('.slide-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = history[parseInt(item.dataset.i)];
      broadcastVerse(h.reference, h.text, h.translation);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// ====== INIT SELECTS ======
function initBooks() {
  TRANSLATIONS.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.code; opt.textContent = t.name;
    els.translation.appendChild(opt);
  });
  els.translation.value = 'FRLSG';

  BIBLE_BOOKS.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = (b.testament === 'AT' ? '🟦 ' : '🟥 ') + b.name;
    els.book.appendChild(opt);
  });
  els.book.value = 43; // Jean par défaut
  updateChapters();
}

function updateChapters() {
  const book = BIBLE_BOOKS.find(b => b.id == els.book.value);
  if (!book) return;
  els.chapter.innerHTML = '';
  for (let i = 1; i <= book.chapters; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = 'Chapitre ' + i;
    els.chapter.appendChild(opt);
  }
  els.chapter.value = book.id === 43 ? 3 : 1; // Jean 3 par défaut
}

// ====== API CALLS (bolls.life) ======
async function fetchChapter(translation, bookId, chapter) {
  const url = `https://bolls.life/get-text/${translation}/${bookId}/${chapter}/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Erreur API: ' + res.status);
  const data = await res.json();
  // data = [{ verse, text, ... }]
  return data;
}

async function searchBible(translation, query) {
  const url = `https://bolls.life/v2/find/${translation}/?search=${encodeURIComponent(query)}&match_case=0&match_whole=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Erreur recherche: ' + res.status);
  return await res.json();
}

function cleanVerseHtml(html) {
  // Retire les balises HTML/notes/Strong et nettoie l'espace
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ /g, ' ')
    .trim();
}

async function loadChapter() {
  els.verseList.innerHTML = '<div class="empty">Chargement…</div>';
  const book = BIBLE_BOOKS.find(b => b.id == els.book.value);
  const chap = parseInt(els.chapter.value);
  const trans = els.translation.value;
  currentBookName = book.name;
  currentChapter = chap;
  currentTranslation = trans;

  try {
    const verses = await fetchChapter(trans, book.id, chap);
    chapterVerses = verses.map(v => ({
      num: v.verse,
      text: cleanVerseHtml(v.text),
      reference: `${book.name} ${chap}:${v.verse}`,
    }));
    renderVerseList();
  } catch (e) {
    els.verseList.innerHTML = `<div class="empty">❌ Impossible de charger.<br>Vérifiez votre connexion ou utilisez l'onglet <strong>Manuel</strong>.<br><small>${escapeHtml(e.message)}</small></div>`;
  }
}

function renderVerseList() {
  if (!chapterVerses.length) {
    els.verseList.innerHTML = '<div class="empty">Aucun verset</div>';
    return;
  }
  els.verseList.innerHTML = chapterVerses.map((v, i) => `
    <div class="verse-item" data-i="${i}">
      <span class="verse-num">${v.num}</span>${escapeHtml(v.text)}
    </div>
  `).join('');
  els.verseList.querySelectorAll('.verse-item').forEach(item => {
    const i = parseInt(item.dataset.i);
    item.addEventListener('click', (e) => {
      // Maj+clic = sélectionner la plage depuis le verset déjà sélectionné.
      if (e.shiftKey && activeIndex >= 0 && activeIndex !== i) setRangeFromList(activeIndex, i);
      else selectVerse(i);
    });
    item.addEventListener('dblclick', () => {
      selectVerse(i);
      sendCurrentVerse();
    });
  });
  // Réafficher le surlignage si une plage est active (la liste vient d'être reconstruite).
  if (verseRange) highlightRangeInList();
}

function selectVerse(i) {
  if (i < 0 || i >= chapterVerses.length) return;
  clearVerseRange(); // un clic simple sort du mode plage
  activeIndex = i;
  els.verseList.querySelectorAll('.verse-item').forEach((el, j) => {
    el.classList.toggle('active', j === i);
    if (j === i) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  const v = chapterVerses[i];
  els.currentRef.textContent = v.reference + ' (sélectionné)';
}

function sendCurrentVerse() {
  // Plage sélectionnée (Maj+clic) : on diffuse son premier écran ; Suivant fait
  // ensuite défiler les écrans.
  if (verseRange) {
    sendRangePage(verseRange.index || 0);
    return;
  }
  if (activeIndex < 0) {
    toast('Sélectionnez d\'abord un verset');
    return;
  }
  const v = chapterVerses[activeIndex];
  broadcastVerse(v.reference, v.text);
}

// ====== SEARCH ======
async function doSearch() {
  const q = els.searchInput.value.trim();
  if (!q) return;
  els.searchResults.innerHTML = '<div class="empty">Recherche…</div>';

  // Détecter si c'est une référence — même parseur que la barre du Studio, donc
  // « Luc 2:1-10 » comme « Luc 2: 1 - 10 » (espaces, tirets typographiques).
  const parsed = parseVerseRef(q);
  if (parsed && !parsed.error) {
    const { book, chap } = parsed;
    const verseStart = parsed.start;
    const verseEnd = parsed.end;
    try {
      const verses = await fetchChapter(els.translation.value, book.id, chap);
      const filtered = verseStart
        ? verses.filter(v => v.verse >= verseStart && v.verse <= verseEnd)
        : verses;
      const results = filtered.map(v => ({
        reference: `${book.name} ${chap}:${v.verse}`,
        text: cleanVerseHtml(v.text),
      }));
      // Plage : entrée « toute la plage » en tête. Un clic dessus la diffuse en
      // écrans successifs (Suivant/Précédent), les entrées suivantes restent
      // des versets isolés.
      if (parsed.isRange && results.length > 1) {
        const pages = buildVersePages(book.name, chap,
          filtered.map(v => ({ num: v.verse, text: cleanVerseHtml(v.text) })));
        results.unshift({
          reference: `${book.name} ${chap}:${verseStart}-${verseEnd}`,
          text: `▶ Diffuser la plage entière — ${results.length} versets en `
              + `${pages.length} écran${pages.length > 1 ? 's' : ''} : `
              + pages.map(p => p.reference.split(':')[1]).join(' · '),
          range: { bookId: book.id, chap, start: verseStart, end: verseEnd },
        });
      }
      renderSearchResults(results);
      return;
    } catch (e) { /* fallback to keyword search */ }
  }

  // Recherche par mot-clé
  try {
    const data = await searchBible(els.translation.value, q);
    const results = (data.results || []).slice(0, 50).map(r => {
      const book = BIBLE_BOOKS.find(b => b.id == r.book);
      return {
        reference: `${book ? book.name : '?'} ${r.chapter}:${r.verse}`,
        text: cleanVerseHtml(r.text),
      };
    });
    renderSearchResults(results);
  } catch (e) {
    els.searchResults.innerHTML = `<div class="empty">❌ Recherche impossible<br><small>${escapeHtml(e.message)}</small></div>`;
  }
}

function renderSearchResults(results) {
  if (!results.length) {
    els.searchResults.innerHTML = '<div class="empty">Aucun résultat</div>';
    return;
  }
  els.searchResults.innerHTML = results.map((r, i) => `
    <div class="search-result" data-i="${i}">
      <div class="search-ref">${escapeHtml(r.reference)}</div>
      <div>${escapeHtml(r.text)}</div>
    </div>
  `).join('');
  els.searchResults.querySelectorAll('.search-result').forEach(el => {
    const i = parseInt(el.dataset.i);
    el.addEventListener('click', async () => {
      const r = results[i];
      if (r.range) {
        const book = BIBLE_BOOKS.find(b => b.id === r.range.bookId);
        if (!book) return;
        try {
          await showVerseRange(book, r.range.chap, r.range.start, r.range.end);
        } catch (e) {
          toast('Impossible de charger la plage : ' + (e.message || 'erreur'));
        }
        return;
      }
      clearVerseRange();
      broadcastVerse(r.reference, r.text);
    });
  });
}

// ====== EVENT BINDINGS ======
els.book.addEventListener('change', updateChapters);
els.loadChapterBtn.addEventListener('click', loadChapter);
els.searchBtn.addEventListener('click', doSearch);
els.searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

els.manualSendBtn.addEventListener('click', () => {
  const ref = els.manualRef.value.trim() || 'Verset';
  const text = els.manualText.value.trim();
  if (!text) { toast('Saisissez un texte'); return; }
  broadcastVerse(ref, text);
});

els.sendLiveBtn.addEventListener('click', sendCurrentVerse);
els.clearLiveBtn.addEventListener('click', clearLive);
// Précédent / Suivant : font défiler les écrans quand une plage est diffusée,
// sinon avancent verset par verset (comportement historique).
els.prevBtn.addEventListener('click', () => {
  if (verseRange) {
    if (verseRange.index > 0) { sendRangePage(verseRange.index - 1); return; }
    const idx = chapterVerses.findIndex(cv => cv.num === verseRange.startNum);
    if (idx >= 0) activeIndex = idx;
    clearVerseRange();
  }
  if (activeIndex > 0) { selectVerse(activeIndex - 1); sendCurrentVerse(); }
});
els.nextBtn.addEventListener('click', () => {
  if (verseRange) {
    if (verseRange.index < verseRange.pages.length - 1) { sendRangePage(verseRange.index + 1); return; }
    const idx = chapterVerses.findIndex(cv => cv.num === verseRange.endNum);
    if (idx >= 0) activeIndex = idx;
    clearVerseRange();
  }
  if (activeIndex < chapterVerses.length - 1) { selectVerse(activeIndex + 1); sendCurrentVerse(); }
});

const openPresenterBtn = document.getElementById('openPresenterBtn');
if (openPresenterBtn) {
  openPresenterBtn.addEventListener('click', () => {
    const url = new URL('presenter.html', window.location.href).href;
    window.open(url, 'presenter-view', 'width=1100,height=720');
  });
}

// ====== AGRANDIR / PLEIN ÉCRAN ======
function setExpanded(on) {
  document.querySelector('.app').classList.toggle('expanded', on);
  els.expandBtn.textContent = on ? '🔳 Réduire' : '🔲 Agrandir';
  els.expandBtn.title = on ? 'Réduire (F ou Échap)' : 'Agrandir l\'aperçu (F)';
}
function toggleExpanded() {
  const isOn = !document.querySelector('.app').classList.contains('expanded');
  setExpanded(isOn);
}
function toggleFullscreen() {
  const previewArea = document.querySelector('.preview-area');
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    (previewArea.requestFullscreen?.() || previewArea.webkitRequestFullscreen?.());
  } else {
    (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
  }
}
els.expandBtn.addEventListener('click', toggleExpanded);
els.fullscreenBtn.addEventListener('click', toggleFullscreen);

// ====== AJUSTEMENT MANUEL (drag-to-resize) ======
const LAYOUT_KEY = 'versetlive:layout';
const DEFAULT_LEFT = 320;
const DEFAULT_RIGHT = 360;
const MIN_PANEL = 0;       // Permet d'aller jusqu'à 0 (panneau quasi caché)
const MAX_LEFT_RATIO = 0.6;
const MAX_RIGHT_RATIO = 0.6;

function applyLayout(leftPx, rightPx) {
  const app = document.querySelector('.app');
  app.style.setProperty('--col-left', leftPx + 'px');
  app.style.setProperty('--col-right', rightPx + 'px');
}

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (saved && typeof saved.left === 'number' && typeof saved.right === 'number') {
      applyLayout(saved.left, saved.right);
    }
  } catch {}
}

function saveLayout() {
  const app = document.querySelector('.app');
  const cs = getComputedStyle(app);
  const left = parseInt(cs.getPropertyValue('--col-left')) || DEFAULT_LEFT;
  const right = parseInt(cs.getPropertyValue('--col-right')) || DEFAULT_RIGHT;
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ left, right }));
}

function setupResizer(el, side) {
  let dragging = false;
  let startX = 0;
  let startSize = 0;

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const app = document.querySelector('.app');
    const cs = getComputedStyle(app);
    startSize = parseInt(cs.getPropertyValue(side === 'left' ? '--col-left' : '--col-right')) || (side === 'left' ? DEFAULT_LEFT : DEFAULT_RIGHT);
    app.classList.add('resizing');
    el.classList.add('active');
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const winW = window.innerWidth;
    let newSize;
    if (side === 'left') {
      newSize = Math.max(MIN_PANEL, Math.min(winW * MAX_LEFT_RATIO, startSize + delta));
      document.querySelector('.app').style.setProperty('--col-left', newSize + 'px');
    } else {
      newSize = Math.max(MIN_PANEL, Math.min(winW * MAX_RIGHT_RATIO, startSize - delta));
      document.querySelector('.app').style.setProperty('--col-right', newSize + 'px');
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.querySelector('.app').classList.remove('resizing');
    el.classList.remove('active');
    saveLayout();
  });

  // Double-clic = réinitialiser à la valeur par défaut
  el.addEventListener('dblclick', () => {
    if (side === 'left') {
      document.querySelector('.app').style.setProperty('--col-left', DEFAULT_LEFT + 'px');
    } else {
      document.querySelector('.app').style.setProperty('--col-right', DEFAULT_RIGHT + 'px');
    }
    saveLayout();
    toast('Panneau réinitialisé');
  });
}

setupResizer(document.getElementById('resizerLeft'), 'left');
setupResizer(document.getElementById('resizerRight'), 'right');
loadLayout();

// Au tout premier lancement, faire pulser les poignées + afficher un message
const HINT_KEY = 'versetlive:resizer-hint-shown';
if (!localStorage.getItem(HINT_KEY)) {
  document.getElementById('resizerLeft').classList.add('hint');
  document.getElementById('resizerRight').classList.add('hint');
  setTimeout(() => toast('💡 Glissez les poignées ↔ pour redimensionner les panneaux'), 600);
  localStorage.setItem(HINT_KEY, '1');
}

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.querySelectorAll('.tab-pane').forEach(p => {
      p.style.display = p.dataset.pane === target ? 'block' : 'none';
    });
    // Le détail du chant n'apparait que sur l'onglet Chants
    const songDetail = document.getElementById('songDetail');
    if (songDetail) {
      songDetail.classList.toggle('visible', target === 'songs');
    }
  });
});

// Style live updates
['fontFamily','fontSize','textColor','textShadow','textAlign','bgType','bgColor','bgOpacity','sceneScale','sceneOffsetX','sceneOffsetY','bgImageScale','bgImageOffsetX','bgImageOffsetY','textOffsetX','textOffsetY','vAlign','showRef','animation']
  .forEach(k => els[k].addEventListener('input', () => {
    refreshRangeLabels();
    if (k === 'textColor') els.textColorHex.value = els.textColor.value;
    if (k === 'bgColor') els.bgColorHex.value = els.bgColor.value;
    broadcastStyleOnly();
  }));

els.textColorHex.addEventListener('change', () => {
  if (/^#[0-9a-fA-F]{6}$/.test(els.textColorHex.value)) {
    els.textColor.value = els.textColorHex.value;
    broadcastStyleOnly();
  }
});
els.bgColorHex.addEventListener('change', () => {
  if (/^#[0-9a-fA-F]{6}$/.test(els.bgColorHex.value)) {
    els.bgColor.value = els.bgColorHex.value;
    broadcastStyleOnly();
  }
});

// Image de fond : pick, clear, dim, fit
els.bgImageInput.addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    bgImageDataUrl = await loadAndCompressImage(f);
    updateBgImageUi();
    broadcastStyleOnly();
    toast('🖼 Image de fond mise à jour');
  } catch (err) {
    toast('Impossible de charger l\'image : ' + err.message);
  } finally {
    e.target.value = ''; // permet de re-sélectionner le même fichier
  }
});
els.bgImageClearBtn.addEventListener('click', () => {
  bgImageDataUrl = null;
  updateBgImageUi();
  broadcastStyleOnly();
  toast('Image de fond retirée');
});
els.bgImageDim.addEventListener('input', () => {
  els.bgImageDimVal.textContent = parseFloat(els.bgImageDim.value).toFixed(2);
  broadcastStyleOnly();
});
els.bgImageFit.addEventListener('change', broadcastStyleOnly);
els.sceneScaleReset.addEventListener('click', () => {
  els.sceneScale.value = 1;
  refreshRangeLabels();
  broadcastStyleOnly();
});
els.sceneOffsetXReset.addEventListener('click', () => {
  els.sceneOffsetX.value = 0;
  refreshRangeLabels();
  broadcastStyleOnly();
});
els.sceneOffsetYReset.addEventListener('click', () => {
  els.sceneOffsetY.value = 0;
  refreshRangeLabels();
  broadcastStyleOnly();
});
els.bgImageScaleReset.addEventListener('click', () => {
  els.bgImageScale.value = 1;
  refreshRangeLabels();
  broadcastStyleOnly();
});
els.bgImageOffsetXReset.addEventListener('click', () => {
  els.bgImageOffsetX.value = 0;
  refreshRangeLabels();
  broadcastStyleOnly();
});
els.bgImageOffsetYReset.addEventListener('click', () => {
  els.bgImageOffsetY.value = 0;
  refreshRangeLabels();
  broadcastStyleOnly();
});
els.textOffsetXReset.addEventListener('click', () => {
  els.textOffsetX.value = 0;
  refreshRangeLabels();
  broadcastStyleOnly();
});
els.textOffsetYReset.addEventListener('click', () => {
  els.textOffsetY.value = 0;
  refreshRangeLabels();
  broadcastStyleOnly();
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowDown' || e.key === 'PageDown') {
    if (activeIndex < chapterVerses.length - 1) selectVerse(activeIndex + 1);
    e.preventDefault();
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    if (activeIndex > 0) selectVerse(activeIndex - 1);
    e.preventDefault();
  } else if (e.key === 'Enter' || e.key === ' ') {
    sendCurrentVerse();
    e.preventDefault();
  } else if (e.key === 'f' || e.key === 'F') {
    toggleExpanded();
    e.preventDefault();
  } else if (e.key === 'Escape') {
    // Priorité : sortir du plein écran, puis du mode agrandi, sinon effacer
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
    } else if (document.querySelector('.app').classList.contains('expanded')) {
      setExpanded(false);
    } else {
      clearLive();
    }
  }
});

// Synchroniser le bouton plein écran avec l'état réel (Échap natif, etc.)
document.addEventListener('fullscreenchange', () => {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  els.fullscreenBtn.textContent = isFs ? '⛌' : '⛶';
  els.fullscreenBtn.title = isFs ? 'Quitter le plein écran (Échap)' : 'Plein écran (F11)';
});

// ====== BOOT ======
initBooks();
restoreStyle();
refreshRangeLabels();
renderHistory();
broadcastStyleOnly(); // pousse le style initial vers la preview
