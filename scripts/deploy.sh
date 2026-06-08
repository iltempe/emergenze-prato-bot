#!/usr/bin/env bash
#
# Redeploy della Edge Function "emergenze" su Supabase.
#
# QUANDO USARLO: ogni volta che modifichi supabase/functions/emergenze/index.ts
# (soglie, messaggi, logica) e vuoi pubblicare la nuova versione in produzione.
#
# USO:
#   ./scripts/deploy.sh
#
# REQUISITI (una tantum):
#   1. Supabase CLI installato:
#        macOS:   brew install supabase/tap/supabase
#        altri:   https://supabase.com/docs/guides/cli
#   2. Autenticazione, in UNO di questi modi:
#        - una tantum:  supabase login
#        - oppure esporta un token:  export SUPABASE_ACCESS_TOKEN="sbp_..."
#          (lo crei in Dashboard -> Account -> Access Tokens)
#
# Variabili opzionali:
#   SUPABASE_PROJECT_REF   ref del progetto (default: pfzfegfaagzeupopqaqj)
#   SKIP_SMOKE=1           salta lo smoke test post-deploy
#
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-pfzfegfaagzeupopqaqj}"
FUNC="emergenze"

# Vai sempre alla root del repo (lo script puo' essere lanciato da ovunque)
cd "$(dirname "$0")/.."

# --- Pre-check: CLI presente? ---
if ! command -v supabase >/dev/null 2>&1; then
  echo "✗ Supabase CLI non trovato." >&2
  echo "  Installa con:  brew install supabase/tap/supabase" >&2
  echo "  (oppure vedi https://supabase.com/docs/guides/cli)" >&2
  exit 1
fi

# --- Pre-check: file della funzione presente? ---
ENTRY="supabase/functions/${FUNC}/index.ts"
if [ ! -f "$ENTRY" ]; then
  echo "✗ Non trovo $ENTRY (sei nella repo giusta?)." >&2
  exit 1
fi

# --- Deploy ---
# verify_jwt resta TRUE (default): la funzione viene invocata dai cron con la
# service_role key nell'header Authorization, quindi NON va resa pubblica.
echo "→ Deploy di '${FUNC}' sul progetto ${PROJECT_REF} ..."
supabase functions deploy "$FUNC" --project-ref "$PROJECT_REF"
echo "✓ Deploy completato."

# --- Smoke test opzionale (mode=tick): conferma che la funzione risponde 200 ---
# Richiede SUPABASE_URL e SUPABASE_SERVICE_KEY (presi da .env se presente).
if [ "${SKIP_SMOKE:-0}" = "1" ]; then
  exit 0
fi
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
  echo "→ Smoke test (mode=tick)..."
  code=$(curl -s -o /tmp/emergenze_smoke.json -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/functions/v1/${FUNC}?mode=tick" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
    -H "Content-Type: application/json" -d '{}' || true)
  echo "  HTTP ${code}: $(cat /tmp/emergenze_smoke.json 2>/dev/null)"
  if [ "$code" = "200" ]; then
    echo "✓ Smoke test ok."
  else
    echo "⚠ Smoke test non 200 — controlla i log: supabase functions logs ${FUNC} --project-ref ${PROJECT_REF}" >&2
  fi
else
  echo "ℹ Smoke test saltato (manca SUPABASE_URL/SUPABASE_SERVICE_KEY in .env)."
fi
