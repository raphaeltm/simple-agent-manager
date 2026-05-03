#!/usr/bin/env bash
# Ensure an AI Gateway exists for the deployment environment.
# Idempotent: creates the gateway if it doesn't exist, no-ops if it does.
#
# Required env vars:
#   CF_API_TOKEN    — Cloudflare API token with AI Gateway permissions
#   CF_ACCOUNT_ID   — Cloudflare account ID
#   AI_GATEWAY_ID   — Gateway slug (default: "sam")

set -euo pipefail

GATEWAY_ID="${AI_GATEWAY_ID:-sam}"
AUTHENTICATION="${AI_GATEWAY_AUTHENTICATION:-true}"

echo "Ensuring AI Gateway '${GATEWAY_ID}' exists..."

# Check if gateway already exists
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}")

if [ "$HTTP_CODE" -eq 200 ]; then
  echo "AI Gateway '${GATEWAY_ID}' already exists"
  # CF AI Gateway API uses PUT (not PATCH) for updates — PATCH returns 404.
  # See: https://developers.cloudflare.com/api/resources/ai_gateway/methods/update/
  UPDATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X PUT "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"id\": \"${GATEWAY_ID}\",
      \"authentication\": ${AUTHENTICATION},
      \"collect_logs\": true,
      \"cache_ttl\": 0,
      \"cache_invalidate_on_update\": true,
      \"rate_limiting_interval\": 0,
      \"rate_limiting_limit\": 0,
      \"rate_limiting_technique\": \"fixed\"
    }")
  UPDATE_HTTP_CODE=$(echo "$UPDATE_RESPONSE" | tail -1)
  UPDATE_BODY=$(echo "$UPDATE_RESPONSE" | sed '$d')
  if [ "$UPDATE_HTTP_CODE" -ge 200 ] && [ "$UPDATE_HTTP_CODE" -lt 300 ]; then
    echo "AI Gateway '${GATEWAY_ID}' updated (authentication=${AUTHENTICATION})"
  else
    echo "::warning::Failed to update AI Gateway (HTTP ${UPDATE_HTTP_CODE}): ${UPDATE_BODY}"
  fi
  exit 0
fi

echo "Creating AI Gateway '${GATEWAY_ID}'..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${GATEWAY_ID}\",
    \"authentication\": ${AUTHENTICATION},
    \"collect_logs\": true,
    \"cache_ttl\": 0,
    \"cache_invalidate_on_update\": true,
    \"rate_limiting_interval\": 0,
    \"rate_limiting_limit\": 0
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "AI Gateway '${GATEWAY_ID}' created successfully"
elif [ "$HTTP_CODE" -eq 409 ]; then
  echo "AI Gateway '${GATEWAY_ID}' already exists (409 conflict — OK)"
else
  echo "::warning::Failed to create AI Gateway (HTTP ${HTTP_CODE}): ${BODY}"
  echo "AI proxy will fall back to Workers AI REST API (no caching/logging)"
fi
