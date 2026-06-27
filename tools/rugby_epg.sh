#!/usr/bin/env bash
# Rafraîchit www/data/rugby_tv.json depuis l'EPG et pousse si changé (data-only).
# Le CI ignore ce fichier (paths-ignore) -> pas de rebuild APK ; l'app le
# récupère au runtime via GitHub raw.
set -euo pipefail
REPO="$HOME/flux-rss-app"
cd "$REPO"
git pull --ff-only -q origin master
python3 tools/rugby_epg.py
if ! git diff --quiet -- www/data/rugby_tv.json; then
  git add www/data/rugby_tv.json
  git -c user.name="laurentsar" -c user.email="laurentsar@gmail.com" \
      commit -q -m "data(epg): refresh grille TV rugby [skip ci]"
  git -c credential.helper=store push -q origin HEAD:master
  echo "$(date '+%F %T') rugby_tv.json mis à jour et poussé"
else
  echo "$(date '+%F %T') pas de changement"
fi
