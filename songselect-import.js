// Importeur pour fichiers téléchargés depuis SongSelect (CCLI)
// Formats supportés : TEXT (.txt), OpenLyrics (.xml), ChordPro (.cho/.crd/.pro)
// Le contenu vient de l'utilisateur licencié — l'app ne télécharge rien depuis SongSelect.

const SS_SECTION_MAP = {
  verse: 'verse',
  v: 'verse',
  couplet: 'verse',
  c: 'verse', // attention : 'c' peut être chorus dans OpenLyrics
  chorus: 'chorus',
  refrain: 'chorus',
  ref: 'chorus',
  bridge: 'bridge',
  pont: 'bridge',
  prechorus: 'prechorus',
  'pre-chorus': 'prechorus',
  ending: 'ending',
  outro: 'ending',
  tag: 'ending',
  intro: 'verse',
};

function ssDetectFormat(filename, content) {
  const name = (filename || '').toLowerCase();
  const head = (content || '').slice(0, 500);
  if (name.endsWith('.xml') || /<song\s|openlyrics\.info/i.test(head)) return 'openlyrics';
  if (name.endsWith('.cho') || name.endsWith('.crd') || name.endsWith('.pro') || /\{title:|\{t:/i.test(head)) return 'chordpro';
  return 'text';
}

// ==== TEXT (SongSelect format standard) ====
// Exemple:
//   Title Here
//   CCLI Song # 12345
//   Author1 | Author2
//
//   Verse 1
//   line 1
//   line 2
//
//   Chorus
//   ...
function ssParseText(content) {
  const lines = content.split(/\r?\n/);
  let title = '', author = '', ccli = '', copyright = '';
  const sections = [];
  let current = null;
  let i = 0;

  // Header : 1ère ligne = titre, puis CCLI / auteur / © avant 1ère section
  // On parse jusqu'à trouver une étiquette de section
  const sectionLabelRe = /^\s*(verse|couplet|chorus|refrain|bridge|pont|pre[-\s]?chorus|pré[-\s]?refrain|tag|ending|outro|intro|interlude)\s*([0-9a-z]*)\s*$/i;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }

    // Header detection
    if (!title) {
      title = line;
      i++;
      continue;
    }
    const lower = line.toLowerCase();
    if (lower.startsWith('ccli song') || lower.startsWith('ccli #') || /^ccli\s*song\s*#/i.test(line)) {
      ccli = line.replace(/^ccli\s*song\s*#?\s*:?\s*/i, '').trim();
      i++;
      continue;
    }
    if (lower.startsWith('ccli license') || lower.startsWith('licence ccli')) {
      i++;
      continue;
    }
    if (line.startsWith('©') || lower.startsWith('copyright')) {
      copyright = line.replace(/^©\s*|^copyright\s*[:©]?\s*/i, '').trim();
      i++;
      continue;
    }

    const sm = sectionLabelRe.exec(line);
    if (sm) {
      // Nouvelle section
      if (current && current.lines.length) sections.push(current);
      const kindRaw = sm[1].toLowerCase().replace(/[\s-]/g, '');
      const labelNum = sm[2] ? sm[2].trim() : '';
      const type = SS_SECTION_MAP[kindRaw] || (kindRaw.includes('chorus') ? 'chorus' : kindRaw.includes('verse') ? 'verse' : 'verse');
      let label = sm[1].trim();
      // Normalise les labels en français
      const labelFr = type === 'chorus' ? 'Refrain'
                    : type === 'bridge' ? 'Pont'
                    : type === 'prechorus' ? 'Pré-refrain'
                    : type === 'ending' ? 'Final'
                    : 'Couplet';
      label = labelNum ? `${labelFr} ${labelNum}` : labelFr;
      current = { type, label, lines: [] };
      i++;
      continue;
    }

    // Si pas encore d'auteur défini et la ligne ressemble à des noms (avant 1ère section)
    if (!current && /^[A-Z][A-Za-zéèêàâïîôûùçÉÈÊÀÂÏÎÔÛÙÇ\s\.,'\-\|&]+$/.test(line) && line.length < 200) {
      author = author ? author + ' | ' + line : line;
      i++;
      continue;
    }

    // Ligne de paroles
    if (!current) {
      // Pas de section explicite : on ouvre un Couplet 1 implicite
      current = { type: 'verse', label: 'Couplet 1', lines: [] };
    }
    current.lines.push(line);
    i++;
  }
  if (current && current.lines.length) sections.push(current);

  // Numérote automatiquement les couplets / refrains si nécessaire
  let vCount = 0, cCount = 0, bCount = 0;
  sections.forEach(s => {
    if (s.type === 'verse') {
      vCount++;
      if (!/\d/.test(s.label)) s.label = `Couplet ${vCount}`;
    } else if (s.type === 'chorus') {
      cCount++;
      if (cCount > 1 && !/\d/.test(s.label)) s.label = `Refrain ${cCount}`;
    } else if (s.type === 'bridge') {
      bCount++;
      if (bCount > 1 && !/\d/.test(s.label)) s.label = `Pont ${bCount}`;
    }
  });

  return {
    title,
    author,
    ccli,
    copyright,
    sections: sections.map(s => ({
      type: s.type,
      label: s.label,
      text: s.lines.join('\n'),
    })),
  };
}

// ==== OpenLyrics XML ====
function ssParseOpenLyrics(content) {
  const doc = new DOMParser().parseFromString(content, 'text/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML invalide');

  const titleEl = doc.querySelector('properties > titles > title');
  const title = titleEl?.textContent.trim() || '';
  const authors = Array.from(doc.querySelectorAll('properties > authors > author'))
    .map(a => a.textContent.trim())
    .join(' | ');
  const ccli = doc.querySelector('properties > ccliNo')?.textContent.trim() || '';
  const copyright = doc.querySelector('properties > copyright')?.textContent.trim() || '';

  const sections = [];
  const verseEls = doc.querySelectorAll('lyrics > verse');
  verseEls.forEach(v => {
    const name = (v.getAttribute('name') || '').toLowerCase();
    let type = 'verse';
    let label = 'Couplet';
    if (name.startsWith('c')) { type = 'chorus'; label = 'Refrain'; }
    else if (name.startsWith('b')) { type = 'bridge'; label = 'Pont'; }
    else if (name.startsWith('p')) { type = 'prechorus'; label = 'Pré-refrain'; }
    else if (name.startsWith('e') || name.startsWith('o') || name.startsWith('t')) { type = 'ending'; label = 'Final'; }

    const m = name.match(/(\d+)/);
    if (m) label = `${label} ${m[1]}`;

    // Récupère le texte (gère <br/> et <lines>)
    const linesEls = v.querySelectorAll('lines');
    const lines = [];
    linesEls.forEach(le => {
      // Convertit <br/> en \n
      const html = le.innerHTML.replace(/<br\s*\/?>/gi, '\n');
      // Strip remaining XML tags (chord, comment, etc.)
      const text = html.replace(/<[^>]+>/g, '').trim();
      if (text) lines.push(text);
    });
    const text = lines.join('\n');
    if (text) sections.push({ type, label, text });
  });

  return { title, author: authors, ccli, copyright, sections };
}

// ==== ChordPro / OnSong ====
function ssParseChordPro(content) {
  let title = '', author = '', ccli = '', copyright = '';
  const sections = [];
  let current = null;

  const lines = content.split(/\r?\n/);
  for (let raw of lines) {
    let line = raw;
    // Directives {key: value}
    const dir = line.match(/^\s*\{(\w+)\s*:?\s*([^}]*)\}\s*$/);
    if (dir) {
      const key = dir[1].toLowerCase();
      const val = dir[2].trim();
      if (key === 'title' || key === 't') title = val;
      else if (key === 'subtitle' || key === 'st' || key === 'artist') author = val;
      else if (key === 'ccli') ccli = val;
      else if (key === 'copyright') copyright = val;
      else if (key === 'comment' || key === 'c') {
        const lower = val.toLowerCase();
        let type = 'verse', label = 'Couplet';
        if (/refrain|chorus/.test(lower)) { type = 'chorus'; label = 'Refrain'; }
        else if (/pont|bridge/.test(lower)) { type = 'bridge'; label = 'Pont'; }
        else if (/pré-refrain|prechorus/.test(lower)) { type = 'prechorus'; label = 'Pré-refrain'; }
        else if (/final|ending|outro|tag/.test(lower)) { type = 'ending'; label = 'Final'; }
        const m = val.match(/(\d+)/);
        if (m) label = `${label} ${m[1]}`;
        else label = val.replace(/^[\s:]+|[\s:]+$/g, '') || label;
        if (current && current.lines.length) sections.push(current);
        current = { type, label, lines: [] };
      } else if (key === 'soc') { // start of chorus
        if (current && current.lines.length) sections.push(current);
        current = { type: 'chorus', label: 'Refrain', lines: [] };
      } else if (key === 'sov') { // start of verse
        if (current && current.lines.length) sections.push(current);
        current = { type: 'verse', label: 'Couplet', lines: [] };
      } else if (key === 'eoc' || key === 'eov') {
        if (current && current.lines.length) sections.push(current);
        current = null;
      }
      continue;
    }
    // Retire les accords [Em] [G] etc.
    line = line.replace(/\[[^\]]+\]/g, '').trim();
    if (!line) continue;
    if (!current) current = { type: 'verse', label: 'Couplet 1', lines: [] };
    current.lines.push(line);
  }
  if (current && current.lines.length) sections.push(current);

  // Renumber
  let v = 0, c = 0, b = 0;
  sections.forEach(s => {
    if (s.type === 'verse') { v++; if (!/\d/.test(s.label)) s.label = `Couplet ${v}`; }
    else if (s.type === 'chorus') { c++; if (c > 1 && !/\d/.test(s.label)) s.label = `Refrain ${c}`; }
    else if (s.type === 'bridge') { b++; if (b > 1 && !/\d/.test(s.label)) s.label = `Pont ${b}`; }
  });

  return { title, author, ccli, copyright, sections };
}

// ==== POINT D'ENTRÉE ====
async function importSongSelectFiles(files) {
  const imported = [];
  const errors = [];
  for (const file of files) {
    try {
      const content = await file.text();
      const fmt = ssDetectFormat(file.name, content);
      let parsed;
      if (fmt === 'openlyrics') parsed = ssParseOpenLyrics(content);
      else if (fmt === 'chordpro') parsed = ssParseChordPro(content);
      else parsed = ssParseText(content);

      if (!parsed.title) parsed.title = file.name.replace(/\.[^.]+$/, '');
      if (!parsed.sections.length) {
        errors.push(`${file.name} : aucune section parsée`);
        continue;
      }

      const song = {
        id: generateSongId(),
        number: '',
        title: parsed.title,
        author: parsed.author,
        book: 'Chants de Louange',
        ccli: parsed.ccli || undefined,
        copyright: parsed.copyright || undefined,
        sections: parsed.sections,
      };
      imported.push(song);
    } catch (e) {
      errors.push(`${file.name} : ${e.message}`);
    }
  }
  return { imported, errors };
}

// Branche le bouton "Importer SongSelect" si présent
function initSongSelectImport() {
  const btn = document.getElementById('importSongSelectBtn');
  const input = document.getElementById('songSelectFileInput');
  if (!btn || !input) return;

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const { imported, errors } = await importSongSelectFiles(files);
    if (imported.length) {
      // Vérifie les doublons par titre+ccli
      const existingKeys = new Set(allSongs.map(s => `${s.title}|${s.ccli || ''}`));
      const fresh = imported.filter(s => !existingKeys.has(`${s.title}|${s.ccli || ''}`));
      const skipped = imported.length - fresh.length;
      allSongs.push(...fresh);
      saveSongs(allSongs);
      renderSongsList();
      if (typeof toast === 'function') {
        let msg = `${fresh.length} chant(s) importé(s)`;
        if (skipped) msg += ` · ${skipped} doublon(s) ignoré(s)`;
        if (errors.length) msg += ` · ${errors.length} erreur(s)`;
        toast(msg);
      }
    }
    if (errors.length) {
      console.warn('Import errors:', errors);
      if (!imported.length) alert('Aucun fichier valide.\n\n' + errors.join('\n'));
    }
    input.value = '';
  });
}

initSongSelectImport();

// ============== Modal "Coller depuis SongSelect" ==============
function initPasteModal() {
  const btn = document.getElementById('pasteSongSelectBtn');
  const modal = document.getElementById('pasteModal');
  if (!btn || !modal) return;
  const textarea = document.getElementById('pasteTextarea');
  const preview = document.getElementById('pastePreview');
  const importBtn = document.getElementById('pasteImportBtn');
  const closeBtn = document.getElementById('pasteModalClose');
  const cancelBtn = document.getElementById('pasteCancelBtn');

  let lastParsed = null;

  function open() {
    modal.classList.add('show');
    textarea.value = '';
    preview.innerHTML = '<div class="paste-preview-empty">Colle le contenu pour voir l\'aperçu</div>';
    importBtn.disabled = true;
    lastParsed = null;
    setTimeout(() => textarea.focus(), 50);
  }
  function close() {
    modal.classList.remove('show');
  }

  function refreshPreview() {
    const content = textarea.value.trim();
    if (!content) {
      preview.innerHTML = '<div class="paste-preview-empty">Colle le contenu pour voir l\'aperçu</div>';
      importBtn.disabled = true;
      lastParsed = null;
      return;
    }
    try {
      const parsed = ssParseText(content);
      if (!parsed.title || !parsed.sections.length) {
        preview.innerHTML = '<div class="paste-preview-empty" style="color:#f59e0b">⚠ Impossible de détecter un titre + des sections. Vérifie que tu as collé le contenu d\'une page de chant SongSelect (vue Lyrics).</div>';
        importBtn.disabled = true;
        lastParsed = null;
        return;
      }
      lastParsed = parsed;
      preview.innerHTML = `
        <div class="paste-preview-card">
          <div class="paste-preview-header">
            <strong>${escapeHtml(parsed.title)}</strong>
            ${parsed.author ? `<span class="paste-preview-author">${escapeHtml(parsed.author)}</span>` : ''}
            ${parsed.ccli ? `<span class="paste-preview-ccli">CCLI #${escapeHtml(parsed.ccli)}</span>` : ''}
          </div>
          <div class="paste-preview-sections">
            ${parsed.sections.map(s => `
              <div class="paste-preview-section type-${s.type}">
                <span class="section-badge type-${s.type}">${escapeHtml(s.label)}</span>
                <span class="paste-preview-snippet">${escapeHtml(s.text.split('\n')[0]).slice(0, 80)}…</span>
              </div>
            `).join('')}
          </div>
          <div class="paste-preview-summary">
            ${parsed.sections.filter(s => s.type === 'verse').length} couplet(s) ·
            ${parsed.sections.filter(s => s.type === 'chorus').length} refrain(s) ·
            ${parsed.sections.filter(s => s.type === 'bridge').length} pont(s)
          </div>
        </div>
      `;
      importBtn.disabled = false;
    } catch (e) {
      preview.innerHTML = `<div class="paste-preview-empty" style="color:var(--danger)">Erreur : ${escapeHtml(e.message)}</div>`;
      importBtn.disabled = true;
    }
  }

  function importNow() {
    if (!lastParsed) return;
    // Vérifie doublon (titre + CCLI)
    const existing = allSongs.find(s =>
      s.title === lastParsed.title &&
      ((s.ccli || '') === (lastParsed.ccli || ''))
    );
    if (existing) {
      const overwrite = confirm(`"${lastParsed.title}" existe déjà.\n\nOK = Remplacer\nAnnuler = Garder l'existant`);
      if (overwrite) {
        Object.assign(existing, {
          title: lastParsed.title,
          author: lastParsed.author,
          ccli: lastParsed.ccli,
          copyright: lastParsed.copyright,
          sections: lastParsed.sections,
          book: 'Chants de Louange',
        });
      } else {
        close();
        return;
      }
    } else {
      const song = {
        id: generateSongId(),
        number: '',
        title: lastParsed.title,
        author: lastParsed.author,
        book: 'Chants de Louange',
        ccli: lastParsed.ccli || undefined,
        copyright: lastParsed.copyright || undefined,
        sections: lastParsed.sections,
      };
      allSongs.push(song);
    }
    saveSongs(allSongs);
    renderSongsList();
    close();
    if (typeof toast === 'function') toast(`✓ "${lastParsed.title}" importé`);
  }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  textarea.addEventListener('input', refreshPreview);
  textarea.addEventListener('paste', () => setTimeout(refreshPreview, 50));
  importBtn.addEventListener('click', importNow);
}

initPasteModal();
