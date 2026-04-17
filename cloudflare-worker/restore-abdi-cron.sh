#!/bin/bash
# Restore abdi-briefing-refresh's cron (0 4 * * *) once CF's paid-plan
# 5-cron limit has lifted (propagation was stuck at time of swap).
#
# Idempotent: succeeds if cron is already set, no-ops if limit still active,
# prints the outcome either way. Safe to run repeatedly.
#
# Triggered periodically by CronCreate (session-only) OR manually:
#   bash ~/Downloads/iran-briefing/cloudflare-worker/restore-abdi-cron.sh

set -euo pipefail

# Force wrangler to refresh the OAuth token if expired. It stores
# a refresh_token in the config and auto-renews on any command invocation.
# We discard the output; we just want the side-effect.
npx --yes wrangler whoami >/dev/null 2>&1 || true

CF_TOKEN=$(grep '^oauth_token' ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)
ACCOUNT="00bcfd980e88309e1ac7b96b4f99f0db"
WORKER="abdi-briefing-refresh"
CRON="0 4 * * *"

# Guard against API returning result:null on auth failure (manifests as NoneType)
if [[ -z "$CF_TOKEN" ]]; then
  echo "[$(date -u '+%H:%M:%S UTC')] No wrangler OAuth token available. Run: npx wrangler login"
  exit 1
fi

# Current state?
CURRENT=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$WORKER/schedules" \
  | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
except Exception:
  print('AUTH_ERROR'); sys.exit(0)
result = d.get('result')
if not result:
  err = (d.get('errors') or [{}])[0].get('message', 'auth/result missing')
  print('AUTH_ERROR:' + err); sys.exit(0)
crons = [s.get('cron') for s in result.get('schedules', [])]
print(','.join(crons) or 'NONE')
")

if [[ "$CURRENT" == AUTH_ERROR* ]]; then
  echo "[$(date -u '+%H:%M:%S UTC')] API auth failed: ${CURRENT#AUTH_ERROR:}. Run: npx wrangler login"
  exit 1
fi

if [[ "$CURRENT" == "$CRON" ]]; then
  echo "[$(date -u '+%H:%M:%S UTC')] abdi cron already restored. Done."
  exit 0
fi

# Attempt PUT
RESP=$(curl -s -X PUT \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$WORKER/schedules" \
  -d "[{\"cron\": \"$CRON\"}]")

SUCCESS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success'))")

if [[ "$SUCCESS" == "True" ]]; then
  echo "[$(date -u '+%H:%M:%S UTC')] abdi cron restored ($CRON). Paid-plan propagation has landed."
  exit 0
else
  ERR=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('errors',[{}])[0].get('message','unknown'))")
  echo "[$(date -u '+%H:%M:%S UTC')] Not yet — still blocked: $ERR"
  exit 2
fi
