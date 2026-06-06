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

// Reçoit les commandes de navigation envoyées par le studio (sans
// devoir revenir manuellement sur cet onglet). Le studio envoie
// { type: 'nav', action: 'prev'|'next'|'clear'|'showRef', payload? }.
bc?.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'nav') return;
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
    const ref = String(msg.payload).trim();
    const m = ref.match(/^([\d]?\s*[A-Za-zéèêàâîôùçÉÈÊÀÂÎÔÙÇ]+\.?)\s+(\d+)(?::(\d+))?$/);
    if (!m) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'parse' }); return; }
    const bookName = m[1].trim().toLowerCase();
    const chap = parseInt(m[2]);
    const verseNum = m[3] ? parseInt(m[3]) : 1;
    const book = BIBLE_BOOKS.find(b =>
      b.name.toLowerCase() === bookName ||
      b.name.toLowerCase().startsWith(bookName) ||
      b.short.toLowerCase() === bookName
    );
    if (!book) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'book-not-found' }); return; }
    if (chap < 1 || chap > book.chapters) { bc?.postMessage({ type: 'navAck', ok: false, reason: 'chapter-out-of-range' }); return; }
    try {
      await loadChapterAt(book, chap, verseNum);
      sendCurrentVerse();
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
  sceneScale: document.getElementById('sceneScale'),
  sceneScaleVal: document.getElementById('sceneScaleVal'),
  sceneScaleReset: document.getElementById('sceneScaleReset'),
  sceneOffsetX: document.getElementById('sceneOffsetX'),
  sceneOffsetXVal: document.getElementById('sceneOffsetXVal'),
  sceneOffsetXReset: document.getElementById('sceneOffsetXReset'),
  sceneOffsetY: document.getElementById('sceneOffsetY'),
  sceneOffsetYVal: document.getElementById('sceneOffsetYVal'),
  sceneOffsetYReset: document.getElementById('sceneOffsetYReset'),
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
    sceneScale: parseFloat(els.sceneScale.value),
    sceneOffsetX: parseFloat(els.sceneOffsetX.value),
    sceneOffsetY: parseFloat(els.sceneOffsetY.value),
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

function restoreStyle() {
  try {
    const s = JSON.parse(localStorage.getItem(STYLE_KEY) || 'null');
    if (!s) return;
    if (s.fontFamily) els.fontFamily.value = s.fontFamily;
    if (s.fontSize != null) els.fontSize.value = s.fontSize;
    if (s.textColor) { els.textColor.value = s.textColor; els.textColorHex.value = s.textColor; }
    if (s.textShadow) els.textShadow.value = s.textShadow;
    if (s.textAlign) els.textAlign.value = s.textAlign;
    if (s.bgType) els.bgType.value = s.bgType;
    if (s.bgColor) { els.bgColor.value = s.bgColor; els.bgColorHex.value = s.bgColor; }
    if (s.bgOpacity != null) els.bgOpacity.value = s.bgOpacity;
    if (s.bgImage) bgImageDataUrl = s.bgImage;
    if (s.bgImageDim != null) els.bgImageDim.value = s.bgImageDim;
    if (s.bgImageFit) els.bgImageFit.value = s.bgImageFit;
    if (s.sceneScale != null) els.sceneScale.value = s.sceneScale;
    if (s.sceneOffsetX != null) els.sceneOffsetX.value = s.sceneOffsetX;
    if (s.sceneOffsetY != null) els.sceneOffsetY.value = s.sceneOffsetY;
    if (s.vAlign) els.vAlign.value = s.vAlign;
    if (s.showRef) els.showRef.value = s.showRef;
    if (s.animation) els.animation.value = s.animation;
    refreshRangeLabels();
    updateBgImageUi();
  } catch {}
}

function refreshRangeLabels() {
  els.fontSizeVal.textContent = parseFloat(els.fontSize.value).toFixed(1);
  els.bgOpacityVal.textContent = parseFloat(els.bgOpacity.value).toFixed(2);
  if (els.bgImageDimVal) els.bgImageDimVal.textContent = parseFloat(els.bgImageDim.value).toFixed(2);
  if (els.sceneScaleVal) els.sceneScaleVal.textContent = Math.round(parseFloat(els.sceneScale.value) * 100) + '%';
  if (els.sceneOffsetXVal) els.sceneOffsetXVal.textContent = Math.round(parseFloat(els.sceneOffsetX.value) * 200) + '%';
  if (els.sceneOffsetYVal) els.sceneOffsetYVal.textContent = Math.round(parseFloat(els.sceneOffsetY.value) * 200) + '%';
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

  els.currentRef.textContent = reference || '—';
  els.currentTrans.textContent = state.translation;
  els.liveDot.classList.add('live');
  els.liveStatus.textContent = 'En direct';
  addToHistory(state);
  toast('Diffusion en cours : ' + reference);
}

function clearLive() {
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
    item.addEventListener('click', () => selectVerse(i));
    item.addEventListener('dblclick', () => {
      selectVerse(i);
      sendCurrentVerse();
    });
  });
}

function selectVerse(i) {
  if (i < 0 || i >= chapterVerses.length) return;
  activeIndex = i;
  els.verseList.querySelectorAll('.verse-item').forEach((el, j) => {
    el.classList.toggle('active', j === i);
    if (j === i) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  const v = chapterVerses[i];
  els.currentRef.textContent = v.reference + ' (sélectionné)';
}

function sendCurrentVerse() {
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

  // Détecter si c'est une référence (ex: Jean 3:16, 1 Jean 4:8, Jean 3:18-20)
  const refMatch = q.match(/^([\d]?\s*[A-Za-zéèêàâîôùçÉÈÊÀÂÎÔÙÇ]+\.?)\s+(\d+)(?::(\d+)(?:\s*-\s*(\d+))?)?$/);
  if (refMatch) {
    const bookName = refMatch[1].trim().toLowerCase();
    const chap = parseInt(refMatch[2]);
    const verseStart = refMatch[3] ? parseInt(refMatch[3]) : null;
    const verseEnd = refMatch[4] ? parseInt(refMatch[4]) : verseStart;
    const book = BIBLE_BOOKS.find(b =>
      b.name.toLowerCase() === bookName ||
      b.name.toLowerCase().startsWith(bookName) ||
      b.short.toLowerCase() === bookName
    );
    if (book) {
      try {
        const verses = await fetchChapter(els.translation.value, book.id, chap);
        const filtered = verseStart
          ? verses.filter(v => v.verse >= verseStart && v.verse <= verseEnd)
          : verses;
        const results = filtered.map(v => ({
          reference: `${book.name} ${chap}:${v.verse}`,
          text: cleanVerseHtml(v.text),
        }));
        // Si plage de versets : ajouter en tête une entrée "combinée" diffusable d'un coup
        if (verseStart && verseEnd > verseStart && results.length > 1) {
          const combinedText = results
            .map(r => `${r.reference.split(':')[1]}. ${r.text}`)
            .join(' ');
          results.unshift({
            reference: `${book.name} ${chap}:${verseStart}-${verseEnd}`,
            text: combinedText,
          });
        }
        renderSearchResults(results);
        return;
      } catch (e) { /* fallback to keyword search */ }
    }
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
    el.addEventListener('click', () => {
      const r = results[i];
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
els.prevBtn.addEventListener('click', () => {
  if (activeIndex > 0) { selectVerse(activeIndex - 1); sendCurrentVerse(); }
});
els.nextBtn.addEventListener('click', () => {
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
['fontFamily','fontSize','textColor','textShadow','textAlign','bgType','bgColor','bgOpacity','sceneScale','sceneOffsetX','sceneOffsetY','vAlign','showRef','animation']
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
