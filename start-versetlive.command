#!/bin/bash
# VersetLive — lanceur tout-en-un
# Double-clique ce fichier dans Finder pour :
#   1. démarrer le relais local (dans sa propre fenêtre Terminal)
#   2. ouvrir le Studio dans ton navigateur par défaut

cd "$(dirname "$0")" || exit 1

GREEN='\033[0;32m'
NC='\033[0m'

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  VersetLive — démarrage complet${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""

# 1. Vérifier si le relais tourne déjà (port 8766)
if lsof -ti :8766 > /dev/null 2>&1; then
  echo "✓ Relais déjà en cours d'exécution sur le port 8766"
else
  echo "→ Démarrage du relais dans une nouvelle fenêtre Terminal…"
  open ./relay/start.command
  # Attendre que le relais soit prêt (max 30s)
  echo "  Attente du relais…"
  for i in $(seq 1 60); do
    if lsof -ti :8766 > /dev/null 2>&1; then
      echo "✓ Relais prêt"
      break
    fi
    sleep 0.5
  done
fi

echo ""
echo "→ Ouverture du Studio dans ton navigateur…"
open "https://versetlive.vercel.app/studio.html"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Tout est lancé !${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "Pour arrêter le relais, ferme la fenêtre Terminal du relais"
echo "(ou appuie sur Ctrl+C dedans)."
echo ""

# Cette fenêtre peut se fermer maintenant
sleep 2
exit 0
