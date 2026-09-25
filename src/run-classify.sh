#!/bin/bash
# Full classification run: TMDB (every title) -> AniList/Wikidata for the misses
# -> merge -> rebuild the worker -> deploy. Logs to /home/user/classify-run.log
cd /home/user/stardima-deploy/src
LOG=/home/user/classify-run.log
say() { echo "[$(date -u +%H:%M:%S)] $*" >> "$LOG"; }
say "=== start: TMDB pass over the whole library ==="
node build-tmdb.js 100000 >> $LOG 2>&1
say "tmdb done: $(node -e "console.log(Object.keys(require('./meta-tmdb-state.json').results).length)") results"
say "=== AniList/Wikidata pass for the remaining titles ==="
node build-meta.js 1200 >> $LOG 2>&1
node build-meta.js 1200 >> $LOG 2>&1
say "=== merge ==="
node merge-genres.js >> $LOG 2>&1
say "=== rebuild + deploy ==="
node build-worker.js >> $LOG 2>&1
node build-bundle.js >> $LOG 2>&1
# Credentials come from the environment (never commit them):
#   export CF_ACCOUNT_ID=... CF_API_TOKEN=...
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/stardima-proxy" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -F 'metadata={"main_module":"worker-addon.js","compatibility_date":"2024-09-01"};type=application/json' \
  -F "worker-addon.js=@../worker-addon.js;type=application/javascript+module" >> $LOG 2>&1
say "deployed: $(python3 -c "
import json
try:
  d=json.load(open('/home/user/classify-run.log'.replace('classify-run.log','stardima-deploy/src/deploy.json')))
except Exception: pass
print('see log')" 2>/dev/null)"
sleep 25
curl -s -m 60 "https://stardima-proxy.ingots-18joist.workers.dev/health?deep=1" >> $LOG 2>&1
say "=== DONE ==="
