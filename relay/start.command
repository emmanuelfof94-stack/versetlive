#!/bin/bash
# Lanceur double-cliquable pour le VersetLive Relay.
# Double-clique ce fichier dans Finder pour démarrer le relais.

# Aller dans le dossier de ce script (même si lancé depuis Finder)
cd "$(dirname "$0")" || exit 1

# Couleurs terminal
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  VersetLive Relay — démarrage${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""

# Charger nvm si présent (Node.js installé via nvm)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Vérifier que node est disponible
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js introuvable.${NC}"
  echo ""
  echo "Installe Node.js depuis https://nodejs.org (.pkg pour macOS),"
  echo "puis relance ce script."
  echo ""
  read -p "Appuie sur Entrée pour fermer."
  exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node --version)"

# Installer les dépendances si absentes
if [ ! -d "node_modules" ]; then
  echo ""
  echo -e "${YELLOW}Première utilisation : installation des dépendances (~30s)…${NC}"
  echo ""
  npm install --silent
  if [ $? -ne 0 ]; then
    echo -e "${RED}✗ Échec de l'installation des dépendances.${NC}"
    read -p "Appuie sur Entrée pour fermer."
    exit 1
  fi
  echo -e "${GREEN}✓${NC} Dépendances installées"
fi

echo ""

# Démarrer le relais
node relay.js

# Si on arrive ici, le relais s'est arrêté
echo ""
echo -e "${YELLOW}Relais arrêté.${NC}"
read -p "Appuie sur Entrée pour fermer cette fenêtre."
