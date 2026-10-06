#!/usr/bin/env bash
# Ensure an AI Gateway exists for the deployment environment.
# Idempotent: creates the gateway if it doesn't exist, no-ops if it does.
#
# Required env vars:
#   CF_API_TOKEN    — Cloudflare API token with AI Gateway permissions
#   CF_ACCOUNT_ID   — Cloudflare account ID
#   AI_GATEWAY_ID   — Gateway slug

set -euo pipefail

: "${CF_API_TOKEN:?CF_API_TOKEN is required}"
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID is required}"
: "${AI_GATEWAY_ID:?AI_GATEWAY_ID is required}"

GATEWAY_ID="${AI_GATEWAY_ID}"

echo "Ensuring AI Gateway '${GATEWAY_ID}' exists..."

# Check if gateway already exists
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}")

if [ "$HTTP_CODE" -eq 200 ]; then
  echo "AI Gateway '${GATEWAY_ID}' already exists"
  exit 0
fi

if [ "$HTTP_CODE" -ne 404 ]; then
  echo "::error::Failed to check AI Gateway '${GATEWAY_ID}' (HTTP ${HTTP_CODE})"
  exit 1
fi

echo "Creating AI Gateway '${GATEWAY_ID}'..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${GATEWAY_ID}\",
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
  echo "::error::Failed to create AI Gateway (HTTP ${HTTP_CODE}): ${BODY}"
  exit 1
fi
