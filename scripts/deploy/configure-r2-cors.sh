#!/usr/bin/env bash
#
# Configure R2 bucket CORS rules for direct browser uploads.
#
# Required environment variables:
#   R2_ACCESS_KEY_ID      — R2 S3-compatible API key ID
#   R2_SECRET_ACCESS_KEY  — R2 S3-compatible API secret
#   CF_ACCOUNT_ID         — Cloudflare account ID (for R2 endpoint)
#   R2_BUCKET_NAME        — R2 bucket name (e.g., sam-staging-assets)
#   BASE_DOMAIN           — App domain (e.g., sammy.party or simple-agent-manager.org)
#
# Usage: bash scripts/deploy/configure-r2-cors.sh
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
MISSING=""
for VAR in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CF_ACCOUNT_ID R2_BUCKET_NAME BASE_DOMAIN; do
  if [ -z "${!VAR:-}" ]; then
    MISSING="$MISSING $VAR"
  fi
done

if [ -n "$MISSING" ]; then
  echo "::warning::R2 CORS configuration skipped — missing:${MISSING}. File attachments via presigned URLs will not work."
  exit 0
fi

# ---------------------------------------------------------------------------
# Run the TypeScript CORS configuration script using the AWS SDK
# ---------------------------------------------------------------------------
echo "Configuring R2 CORS for bucket '${R2_BUCKET_NAME}' (origin: https://app.${BASE_DOMAIN})..."

pnpm tsx scripts/deploy/configure-r2-cors.ts

echo -e "${GREEN}R2 CORS configuration complete${NC}"
