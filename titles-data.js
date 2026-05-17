// Modèles de titres et présélections
// Identité visuelle : Église Assemblée de Dieu Broukoi - Jérusalem
// Couleurs extraites du logo officiel (BIENVENUE.mp4) :
//   - Bleu nuit fond   #131536
//   - Bleu royal indigo #322882  (lettre A du monogramme)
//   - Bleu cobalt       #204B9A  (lettre D du monogramme)
//   - Or accent         #B38E29  (slogan / sous-titres)
//   - Blanc texte       #FCFCFC

const AD_BROUKOI = {
  name: 'Église Assemblée de Dieu Broukoi - Jérusalem',
  shortName: 'AD Broukoi - Jérusalem',
  slogan: 'Avec Dieu nous ferons des exploits',
  verse: 'Psaumes 60:14',
  colors: {
    bgDeep: '#131536',
    indigo: '#322882',
    cobalt: '#204B9A',
    gold:   '#B38E29',
    white:  '#FCFCFC',
  },
  logo: 'logo-ad.png',
};

// Variantes de logos AD pré-sélectionnables (filename relatif à index.html / obs.html)
const AD_LOGO_OPTIONS = [
  { id: 'original',    file: 'logo-ad.png',             name: 'Original',     description: 'Logo officiel extrait du film BIENVENUE — monogramme AD avec Bible et croix' },
  { id: 'bible-flame', file: 'logo-ad-bible-flame.svg', name: 'Bible + Flammes', description: 'Pentecôtiste — Bible ouverte, croix et trois langues de feu' },
  { id: 'dove',        file: 'logo-ad-dove.svg',        name: 'Colombe',      description: 'Saint-Esprit — Colombe descendante sur la Parole' },
  { id: 'seal',        file: 'logo-ad-seal.svg',        name: 'Sceau',        description: 'Sceau officiel — Anneau or, monogramme AD au centre, slogan' },
  { id: 'cross-globe', file: 'logo-ad-cross-globe.svg', name: 'Grande Mission', description: 'Croix sur le globe — Allez et faites des disciples (Matt 28:19)' },
];

const TITLE_TEMPLATES = [
  {
    id: 'ad-broukoi',
    name: 'AD Broukoi',
    icon: '✝',
    description: 'Identité Assemblée de Dieu Broukoi — fond bleu nuit, accent or, logo + slogan',
  },
  {
    id: 'ad-broukoi-light',
    name: 'AD clair',
    icon: '☩',
    description: 'Version claire : fond blanc, titre bleu nuit, accent or',
  },
  {
    id: 'classic',
    name: 'Classique',
    icon: '═',
    description: 'Titre centré avec ligne horizontale décorative',
  },
  {
    id: 'elegant',
    name: 'Élégant',
    icon: '✦',
    description: 'Italique avec ornements de chaque côté',
  },
  {
    id: 'banner',
    name: 'Bannière',
    icon: '▬',
    description: 'Bandeau coloré pleine largeur',
  },
  {
    id: 'modern',
    name: 'Moderne',
    icon: '┃',
    description: 'Barre verticale colorée à gauche',
  },
  {
    id: 'card',
    name: 'Carte dégradé',
    icon: '▢',
    description: 'Carte avec dégradé doux',
  },
  {
    id: 'double',
    name: 'Double ligne',
    icon: '═',
    description: 'Encadré entre deux lignes décoratives',
  },
  {
    id: 'ornament',
    name: 'Décoré',
    icon: '❦',
    description: 'Avec motifs décoratifs (style église)',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    icon: '·',
    description: 'Très épuré, juste le texte',
  },
  {
    id: 'lower-third',
    name: 'Tiers inférieur',
    icon: '▁',
    description: 'Bandeau en bas (style TV)',
  },
  {
    id: 'badge',
    name: 'Badge',
    icon: '◆',
    description: 'Pastille colorée arrondie',
  },
];

// Présélections rapides — adaptées au déroulé d'un culte AD Broukoi
const TITLE_PRESETS = [
  { title: 'BIENVENUE AU CULTE', subtitle: 'Que la grâce du Seigneur soit avec vous', template: 'ad-broukoi' },
  { title: 'PRIÈRE D\'OUVERTURE', subtitle: 'Élevons nos cœurs vers le Seigneur', template: 'ad-broukoi' },
  { title: 'LOUANGE & ADORATION', subtitle: 'Chantez à l\'Éternel un cantique nouveau', template: 'ad-broukoi' },
  { title: 'CANTIQUES DE VICTOIRE', subtitle: 'Recueil 1926', template: 'ad-broukoi-light' },
  { title: 'LECTURE BIBLIQUE', subtitle: 'La parole de Dieu est vivante et efficace', template: 'ad-broukoi' },
  { title: 'CONFESSION DE FOI', subtitle: 'Je crois en Dieu, le Père tout-puissant…', template: 'ad-broukoi-light' },
  { title: 'OFFRANDE & DÎME', subtitle: 'Que chacun donne avec joie', template: 'ad-broukoi' },
  { title: 'PRÉDICATION', subtitle: '', template: 'ad-broukoi' },
  { title: 'MÉDITATION', subtitle: 'Avec Dieu nous ferons des exploits — Ps 60:14', template: 'ad-broukoi' },
  { title: 'APPEL À LA CONVERSION', subtitle: 'Aujourd\'hui, si vous entendez sa voix', template: 'ad-broukoi' },
  { title: 'PRIÈRE DE DÉLIVRANCE', subtitle: 'Au nom puissant de Jésus-Christ', template: 'ad-broukoi' },
  { title: 'TÉMOIGNAGE', subtitle: 'Ce que le Seigneur a fait pour moi', template: 'ad-broukoi-light' },
  { title: 'INTERCESSION', subtitle: 'Prions ensemble pour l\'église et la nation', template: 'ad-broukoi' },
  { title: 'SAINTE CÈNE', subtitle: 'Ceci est mon corps livré pour vous', template: 'ad-broukoi' },
  { title: 'BAPTÊME D\'EAU', subtitle: 'Allez, faites de toutes les nations des disciples', template: 'ad-broukoi-light' },
  { title: 'CONSÉCRATION DES ENFANTS', subtitle: 'Laissez venir à moi les petits enfants', template: 'ad-broukoi-light' },
  { title: 'ÉCOLE DU DIMANCHE', subtitle: '', template: 'ad-broukoi-light' },
  { title: 'GROUPE DE JEUNESSE', subtitle: 'Que personne ne méprise ta jeunesse — 1 Tim 4:12', template: 'ad-broukoi' },
  { title: 'GROUPE DES FEMMES', subtitle: 'Femme vertueuse, qui la trouvera ? — Pr 31:10', template: 'ad-broukoi' },
  { title: 'GROUPE DES HOMMES', subtitle: 'Soyez forts et tenez ferme — 1 Co 16:13', template: 'ad-broukoi' },
  { title: 'VEILLÉE DE PRIÈRE', subtitle: 'Veillez et priez — Matt 26:41', template: 'ad-broukoi' },
  { title: 'JEÛNE COLLECTIF', subtitle: 'Le jeûne agréable à l\'Éternel — Ésaïe 58', template: 'ad-broukoi' },
  { title: 'ANNONCES', subtitle: '', template: 'ad-broukoi-light' },
  { title: 'BÉNÉDICTION FINALE', subtitle: 'Que l\'Éternel te bénisse et te garde', template: 'ad-broukoi' },
  { title: 'ENVOI', subtitle: 'Allez et faites des disciples de toutes les nations', template: 'ad-broukoi' },
  { title: 'MERCI DE VOTRE PRÉSENCE', subtitle: 'AD Broukoi - Jérusalem · À très bientôt', template: 'ad-broukoi-light' },
];
