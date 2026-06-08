#!/usr/bin/env bash
#
# Redeploy della Edge Function "emergenze" su Supabase via Management API.
# Non richiede la Supabase CLI: usa curl + un Personal Access Token.
#
# QUANDO USARLO: ogni volta che modifichi supabase/functions/emergenze/index.ts.
#
# USO:
#   ./scripts/deploy.sh
#
# REQUISITI:
#   - In .env (gitignorato) deve esserci:
#        SUPABASE_ACCESS_TOKEN=sbp_...   (Dashboard -> Account -> Access Tokens)
#     oppure esportalo in ambiente prima di lanciare lo script.
#   - Per lo smoke test servono anche SUPABASE_URL e SUPABASE_SERVICE_KEY (in .env).
#
# Variabili opzionali:
#   SUPABASE_PROJECT_REF   ref progetto (default: pfzfegfaagzeupopqaqj)
#   SKIP_SMOKE=1           salta lo smoke test post-deploy
#
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-pfzfegfaagzeupopqaqj}"
FUNC="emergenze"

cd "$(dirname "$0")/.."

# Carica .env (per token, url, service key)
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "✗ Manca SUPABASE_ACCESS_TOKEN (in .env o in ambiente)." >&2
  echo "  Crealo in: Dashboard Supabase -> Account -> Access Tokens" >&2
  exit 1
fi

ENTRY="supabase/functions/${FUNC}/index.ts"
[ -f "$ENTRY" ] || { echo "✗ Non trovo $ENTRY" >&2; exit 1; }

echo "→ Deploy di '${FUNC}' (progetto ${PROJECT_REF}) via Management API ..."
RESP=$(curl -s -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${FUNC}" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -F 'metadata={"name":"'"${FUNC}"'","entrypoint_path":"index.ts","verify_jwt":true};type=application/json' \
  -F "file=@${ENTRY};type=application/typescript")

VER=$(printf '%s' "$RESP" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); print(d.get('version','') if d.get('status')=='ACTIVE' else '')
except Exception: print('')")

if [ -z "$VER" ]; then
  echo "✗ Deploy fallito. Risposta:" >&2
  echo "$RESP" | head -c 800 >&2; echo >&2
  exit 1
fi
echo "✓ Deploy ok — versione ${VER} ACTIVE."

# --- Smoke test (mode=tick) ---
if [ "${SKIP_SMOKE:-0}" = "1" ]; then exit 0; fi
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
  echo "→ Smoke test (mode=tick)..."
  code=$(curl -s -o /tmp/emergenze_smoke.json -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/functions/v1/${FUNC}?mode=tick" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
    -H "Content-Type: application/json" -d '{}' || true)
  echo "  HTTP ${code}: $(cat /tmp/emergenze_smoke.json 2>/dev/null)"
  [ "$code" = "200" ] && echo "✓ Smoke test ok." || echo "⚠ Smoke test non 200 — controlla i log nel dashboard." >&2
else
  echo "ℹ Smoke test saltato (manca SUPABASE_URL/SUPABASE_SERVICE_KEY)."
fi
