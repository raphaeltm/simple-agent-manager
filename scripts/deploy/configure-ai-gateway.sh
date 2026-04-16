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

echo "Ensuring AI Gateway '${GATEWAY_ID}' exists..."

# Check if gateway already exists
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}")

if [ "$HTTP_CODE" -eq 200 ]; then
  echo "AI Gateway '${GATEWAY_ID}' already exists"
  exit 0
fi

echo "Creating AI Gateway '${GATEWAY_ID}'..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${GATEWAY_ID}\"}")

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
