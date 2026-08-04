#!/usr/bin/env bash
# Déploie worker/proxy.js sur Cloudflare Workers via l'API REST.
#
# On n'utilise pas wrangler : le CLI et ses dépendances pèsent plus que la
# place disponible sur la machine, alors que l'API fait le travail en trois
# appels curl.
#
# Prérequis (une fois) :
#   1. Compte Cloudflare (gratuit) → https://dash.cloudflare.com
#   2. Jeton d'API : My Profile → API Tokens → Create Token → Edit Cloudflare
#      Workers (ou permissions « Account / Workers Scripts / Edit »).
#   3. export CF_API_TOKEN=xxxx     (obligatoire)
#      export CF_ACCOUNT_ID=xxxx    (facultatif : deviné si le jeton peut lire
#                                    la liste des comptes)
#
# Usage : worker/deploy.sh [nom-du-worker]        (défaut : flux-rss-proxy)
set -euo pipefail

NAME="${1:-flux-rss-proxy}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://api.cloudflare.com/client/v4"

: "${CF_API_TOKEN:?export CF_API_TOKEN=... (jeton avec Workers Scripts:Edit)}"

api() { curl -sS -H "Authorization: Bearer $CF_API_TOKEN" "$@"; }

# jq n'est pas installé ici : python3 fait le décodage JSON.
jget() { python3 -c 'import json,sys;d=json.load(sys.stdin);print(eval("d"+sys.argv[1]))' "$1"; }
ok()   { python3 -c 'import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get("success") else 1)'; }

if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "→ recherche de l'account id…"
  RESP=$(api "$API/accounts?per_page=50")
  echo "$RESP" | ok || { echo "$RESP"; echo "❌ le jeton ne peut pas lister les comptes : export CF_ACCOUNT_ID=… à la main"; exit 1; }
  CF_ACCOUNT_ID=$(echo "$RESP" | jget '["result"][0]["id"]')
  echo "   account: $CF_ACCOUNT_ID ($(echo "$RESP" | jget '["result"][0]["name"]'))"
fi

echo "→ envoi du script « $NAME »…"
RESP=$(api -X PUT "$API/accounts/$CF_ACCOUNT_ID/workers/scripts/$NAME" \
  -F 'metadata={"main_module":"proxy.js","compatibility_date":"2026-01-01"};type=application/json' \
  -F "proxy.js=@$DIR/proxy.js;type=application/javascript+module")
echo "$RESP" | ok || { echo "$RESP"; echo "❌ échec de l'envoi"; exit 1; }

echo "→ activation de l'URL workers.dev…"
RESP=$(api -X POST "$API/accounts/$CF_ACCOUNT_ID/workers/scripts/$NAME/subdomain" \
  -H 'Content-Type: application/json' --data '{"enabled":true,"previews_enabled":false}')
echo "$RESP" | ok || { echo "$RESP"; echo "⚠️  activation workers.dev refusée (à faire dans le dashboard)"; }

SUB=$(api "$API/accounts/$CF_ACCOUNT_ID/workers/subdomain" | jget '["result"]["subdomain"]' 2>/dev/null || true)
if [ -n "$SUB" ]; then
  URL="https://$NAME.$SUB.workers.dev"
  echo
  echo "✅ déployé : $URL"
  echo "   test : curl -s -H 'Origin: https://laurentsar.github.io' \"$URL/?url=https%3A%2F%2Fwww.lemonde.fr%2Frss%2Fune.xml\" | head -c 120"
  echo
  echo "   Reporter cette URL dans www/app.js → const WORKER_PROXY = '$URL/?url=';"
else
  echo "✅ script déployé (sous-domaine workers.dev à récupérer dans le dashboard)"
fi
