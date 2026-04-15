#!/usr/bin/env bash
#
# Provision a Cloudflare AI Gateway for the SAM platform.
# Creates the gateway if it doesn't exist; no-ops if already present.
# The AI Gateway enables analytics, caching, and rate limiting for
# Workers AI model calls routed through the AI binding.
#
# Required environment variables:
#   CF_API_TOKEN    — Cloudflare API token with AI Gateway permissions
#   CF_ACCOUNT_ID   — Cloudflare account ID
#
# Optional environment variables:
#   AI_GATEWAY_ID   — Gateway slug (default: sam)
#
# Required CF_API_TOKEN permissions:
#   Account > AI Gateway > Edit
#
# Usage: bash scripts/deploy/configure-ai-gateway.sh
#
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
MISSING=""
for VAR in CF_API_TOKEN CF_ACCOUNT_ID; do
  if [ -z "${!VAR:-}" ]; then
    MISSING="$MISSING $VAR"
  fi
done

if [ -n "$MISSING" ]; then
  echo "ERROR: Missing required environment variables:$MISSING"
  exit 1
fi

GATEWAY_ID="${AI_GATEWAY_ID:-sam}"
API_BASE="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways"

# ---------------------------------------------------------------------------
# Check if gateway already exists
# ---------------------------------------------------------------------------
echo "Checking if AI Gateway '${GATEWAY_ID}' exists..."

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "${API_BASE}/${GATEWAY_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json")

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}AI Gateway '${GATEWAY_ID}' already exists — no action needed.${NC}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Create the gateway
# ---------------------------------------------------------------------------
echo "Creating AI Gateway '${GATEWAY_ID}'..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
  "${API_BASE}" \
  -X POST \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${GATEWAY_ID}\",
    \"name\": \"SAM AI Gateway\",
    \"description\": \"AI inference gateway for Simple Agent Manager\",
    \"rate_limiting\": {
      \"rps\": 50,
      \"technique\": \"sliding\"
    },
    \"collect_logs\": true
  }")

BODY=$(echo "$RESPONSE" | head -n -1)
CODE=$(echo "$RESPONSE" | tail -n 1)

if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  echo -e "${GREEN}AI Gateway '${GATEWAY_ID}' created successfully.${NC}"
elif [ "$CODE" = "409" ]; then
  echo -e "${YELLOW}AI Gateway '${GATEWAY_ID}' already exists (409 conflict — race condition).${NC}"
else
  echo "ERROR: Failed to create AI Gateway (HTTP ${CODE})"
  echo "$BODY" | head -c 500
  echo ""
  # Non-fatal — the AI binding works without a gateway, just without analytics
  echo -e "${YELLOW}WARNING: AI Gateway creation failed. The AI proxy will work without gateway analytics.${NC}"
  echo -e "${YELLOW}Ensure CF_API_TOKEN has 'Account > AI Gateway > Edit' permission.${NC}"
  exit 0
fi
