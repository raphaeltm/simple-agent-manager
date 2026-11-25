#!/usr/bin/env bash
# SPIKE (staging only, never production): can the real AI Gateway meter the test-only fake AI
# upstream (apps/api/src/routes/ai-test-upstream-route.ts) as a custom provider? Hosted SAM prices
# monthly AI spend from AI Gateway logs, so a fake is only an honest test there if the gateway
# logs tokens AND cost for it. This step:
#   1. checks the fake route answers on this deployment;
#   2. ensures a custom provider `sam-test-upstream` -> https://api.<domain>/ai/_test-upstream
#      exists (idempotent; a missing token permission is reported, never worked around);
#   3. sends one Anthropic-shaped and one OpenAI-shaped call through the gateway with
#      cf-aig-metadata (userId) and cf-aig-custom-cost;
#   4. reads the gateway logs API and prints ONLY non-secret fields (provider, model, tokens,
#      cost, success, metadata keys).
# Never fails the deploy: it reports a "SPIKE RESULT:" line.
#
# Rule 83: the token reaches curl only through a stdin config (`curl -K -`), never argv, and is
# never printed or transformed.
#
# Required env: CF_API_TOKEN, CF_ACCOUNT_ID, AI_GATEWAY_ID, API_URL, DEPLOY_ENVIRONMENT
set -uo pipefail

: "${CF_API_TOKEN:?}" "${CF_ACCOUNT_ID:?}" "${AI_GATEWAY_ID:?}" "${API_URL:?}" "${DEPLOY_ENVIRONMENT:?}"
if [ "$DEPLOY_ENVIRONMENT" != "staging" ]; then
  echo "SPIKE RESULT: skipped (environment is not staging)"
  exit 0
fi

SLUG="sam-test-upstream"
CF_API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}"
GATEWAY="https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${AI_GATEWAY_ID}/custom-${SLUG}"
BASE_URL="${API_URL%/}/ai/_test-upstream"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

# curl with the token as a header from stdin. $1 = header name, rest = curl args. Prints the
# HTTP status; the body goes to $OUT.
authed() {
  local header="$1"
  shift
  printf 'header = "%s: Bearer %s"\n' "$header" "$CF_API_TOKEN" |
    curl -sS -K - -o "$OUT" -w '%{http_code}' "$@" || echo "000"
}

route=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/v1/messages" \
  -H 'content-type: application/json' --data '{"model":"claude-opus-4-6","max_tokens":8,"messages":[{"role":"user","content":"spike"}]}' || echo 000)
echo "fake route on this deployment: HTTP ${route}"
if [ "$route" != "200" ]; then
  echo "SPIKE RESULT: fake route not reachable (HTTP ${route}); nothing else tried"
  exit 0
fi

code=$(authed Authorization "${CF_API}/ai-gateway/custom-providers?per_page=50")
echo "list custom providers: HTTP ${code}"
if [ "$code" = "200" ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any(p.get("slug")==sys.argv[2] for p in d.get("result") or []) else 1)' "$OUT" "$SLUG"; then
  echo "custom provider ${SLUG}: exists"
else
  body=$(python3 -c 'import json,sys; print(json.dumps({"name":"SAM test upstream (staging spike)","slug":sys.argv[1],"base_url":sys.argv[2]}))' "$SLUG" "$BASE_URL")
  code=$(authed Authorization -X POST "${CF_API}/ai-gateway/custom-providers" -H 'content-type: application/json' --data "$body")
  errs=$(python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print([e.get("code") for e in d.get("errors") or []])' "$OUT")
  echo "create custom provider ${SLUG}: HTTP ${code} errors=${errs}"
  if [ "$code" != "200" ] && [ "$code" != "201" ]; then
    echo "SPIKE RESULT: the pipeline CF token cannot create AI Gateway custom providers (HTTP ${code}, ${errs}); stop and ask (token scope is Raphael's call)"
    exit 0
  fi
fi

meta='{"userId":"sam-test-upstream-spike"}'
cost='{"per_token_in":0.000005,"per_token_out":0.000025}'
for shape in messages chat; do
  if [ "$shape" = messages ]; then
    path=v1/messages
    data='{"model":"claude-opus-4-6","max_tokens":8,"messages":[{"role":"user","content":"spike"}]}'
  else
    path=v1/chat/completions
    data='{"model":"gpt-5.4","messages":[{"role":"user","content":"spike"}]}'
  fi
  code=$(authed cf-aig-authorization -X POST "${GATEWAY}/${path}" -H 'content-type: application/json' \
    -H "cf-aig-metadata: ${meta}" -H "cf-aig-custom-cost: ${cost}" --data "$data")
  echo "gateway call ${shape}: HTTP ${code}"
done

sleep 45
code=$(authed Authorization "${CF_API}/ai-gateway/gateways/${AI_GATEWAY_ID}/logs?per_page=25&order_by=created_at&order_by_direction=desc")
echo "logs API: HTTP ${code}"
python3 - "$OUT" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("SPIKE RESULT: logs API returned no JSON"); sys.exit(0)
rows = []
for e in d.get("result") or []:
    meta = e.get("metadata") or {}
    if isinstance(meta, str):
        try: meta = json.loads(meta)
        except Exception: meta = {}
    if str(e.get("provider", "")).startswith("custom") or meta.get("userId") == "sam-test-upstream-spike":
        rows.append({k: e.get(k) for k in ("provider", "model", "path", "tokens_in", "tokens_out", "cost", "success")} | {"metadataKeys": sorted(meta)})
for r in rows:
    print("log:", json.dumps(r))
priced = [r for r in rows if (r.get("cost") or 0) > 0]
if priced:
    print(f"SPIKE RESULT: gateway logged cost for the custom provider ({len(priced)}/{len(rows)} entries)")
elif rows:
    print(f"SPIKE RESULT: gateway logged {len(rows)} custom-provider entries but NO cost")
else:
    print("SPIKE RESULT: no custom-provider entries found in the latest logs")
PY
exit 0
