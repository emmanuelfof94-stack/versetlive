// Chants de Victoire & autres recueils — données initiales
// Les chants ci-dessous sont du domaine public.
// L'utilisateur peut ajouter / importer / exporter d'autres chants.

const SONGS_STORAGE_KEY = 'versetlive:songs';
const SONGS_VERSION = 1;

const SONG_BOOKS = [
  'Chants de Victoire',
  'Chants de Louange',
  'Ailes de la Foi',
  "J'aime l'Éternel",
  'Jeunesse en Mission',
  'Hymnes & Louanges',
  'Autre',
];

const LOUANGE_BOOKS = ['Chants de Louange', 'Louange'];
function isLouangeSong(s) {
  return LOUANGE_BOOKS.includes(s.book);
}

const SECTION_TYPES = {
  verse: { label: 'Couplet', color: '#6366f1' },
  chorus: { label: 'Refrain', color: '#10b981' },
  bridge: { label: 'Pont', color: '#f59e0b' },
  prechorus: { label: 'Pré-refrain', color: '#a855f7' },
  ending: { label: 'Final', color: '#ef4444' },
};

// Catalogue par défaut : Chants de Victoire 1926 (domaine public)
// Le contenu réel est défini dans chants-cv-data.js (chargé avant ce fichier).
const DEFAULT_SONGS = (typeof CHANTS_VICTOIRE_1926 !== 'undefined')
  ? CHANTS_VICTOIRE_1926
  : [];

function loadSongs() {
  try {
    const raw = localStorage.getItem(SONGS_STORAGE_KEY);
    if (!raw) {
      saveSongs(DEFAULT_SONGS);
      return [...DEFAULT_SONGS];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_SONGS];
    return parsed;
  } catch {
    return [...DEFAULT_SONGS];
  }
}

function saveSongs(songs) {
  try {
    localStorage.setItem(SONGS_STORAGE_KEY, JSON.stringify(songs));
  } catch (e) {
    console.warn('Impossible de sauver les chants', e);
  }
}

function generateSongId() {
  return 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
