// Modèles de titres et présélections
// Inspiré de la fonction "Titre" d'Amayo

const TITLE_TEMPLATES = [
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

// Présélections rapides typiques d'un culte
const TITLE_PRESETS = [
  { title: 'BIENVENUE', subtitle: 'Que la grâce du Seigneur soit avec vous', template: 'elegant' },
  { title: 'PRIÈRE D\'OUVERTURE', subtitle: '', template: 'classic' },
  { title: 'LOUANGE & ADORATION', subtitle: 'Chantez à l\'Éternel un cantique nouveau', template: 'banner' },
  { title: 'LECTURE BIBLIQUE', subtitle: '', template: 'ornament' },
  { title: 'CONFESSION DE FOI', subtitle: 'Je crois en Dieu...', template: 'double' },
  { title: 'OFFRANDE', subtitle: 'Que chacun donne avec joie', template: 'card' },
  { title: 'PRÉDICATION', subtitle: '', template: 'modern' },
  { title: 'MÉDITATION', subtitle: '', template: 'elegant' },
  { title: 'TÉMOIGNAGE', subtitle: '', template: 'classic' },
  { title: 'INTERCESSION', subtitle: 'Prions ensemble', template: 'ornament' },
  { title: 'SAINTE CÈNE', subtitle: 'Ceci est mon corps...', template: 'double' },
  { title: 'BAPTÊME', subtitle: '', template: 'card' },
  { title: 'ANNONCES', subtitle: '', template: 'lower-third' },
  { title: 'BÉNÉDICTION', subtitle: 'Que l\'Éternel te bénisse et te garde', template: 'elegant' },
  { title: 'ENVOI', subtitle: 'Allez et faites des disciples', template: 'banner' },
  { title: 'MERCI DE VOTRE PRÉSENCE', subtitle: 'À très bientôt', template: 'card' },
];
