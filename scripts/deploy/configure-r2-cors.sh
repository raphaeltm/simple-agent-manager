#!/usr/bin/env bash
#
# Configure R2 bucket CORS rules for direct browser uploads.
# Uses the Cloudflare REST API (not S3-compatible API) because the R2 S3 token
# typically has Object Read & Write permissions only, not Admin permissions
# needed for PutBucketCors.
#
# Required environment variables:
#   CF_API_TOKEN    — Cloudflare API token (same one used for wrangler)
#   CF_ACCOUNT_ID   — Cloudflare account ID
#   R2_BUCKET_NAME  — R2 bucket name (e.g., sam-staging-assets)
#   BASE_DOMAIN     — App domain (e.g., sammy.party or simple-agent-manager.org)
#
# Usage: bash scripts/deploy/configure-r2-cors.sh
#
set -euo pipefail

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

GREEN='\033[0;32m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
MISSING=""
for VAR in CF_API_TOKEN CF_ACCOUNT_ID R2_BUCKET_NAME BASE_DOMAIN; do
  if [ -z "${!VAR:-}" ]; then
    MISSING="$MISSING $VAR"
  fi
done

if [ -n "$MISSING" ]; then
  echo "::error::R2 CORS configuration failed — missing required env vars:${MISSING}. File attachments via presigned URLs will not work."
  exit 1
fi

# ---------------------------------------------------------------------------
# Configure CORS using Cloudflare REST API
# ---------------------------------------------------------------------------
APP_ORIGIN="https://app.${BASE_DOMAIN}"

echo "Configuring R2 CORS for bucket '${R2_BUCKET_NAME}' (origin: ${APP_ORIGIN})..."

# Only PUT is allowed — all R2 reads flow through the authenticated Worker proxy.
# Omitting GET prevents leaked presigned GET URLs from being usable cross-origin.
# AllowedHeaders wildcard is safe: presigned URL signature enforces authorization.
CORS_PAYLOAD=$(cat <<CORSEOF
{
  "rules": [
    {
      "allowed": {
        "origins": ["${APP_ORIGIN}"],
        "methods": ["PUT"],
        "headers": ["*"]
      },
      "exposed_headers": ["ETag"],
      "max_age_seconds": 3600
    }
  ]
}
CORSEOF
)

RESPONSE=$(curl -s -o "$TMPFILE" -w "%{http_code}" \
  -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/cors" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${CORS_PAYLOAD}")

BODY=$(cat "$TMPFILE" 2>/dev/null || echo "(empty)")

if [ "$RESPONSE" -ge 200 ] && [ "$RESPONSE" -lt 300 ]; then
  echo -e "${GREEN}R2 CORS configured successfully (HTTP ${RESPONSE})${NC}"
  echo "  Bucket: ${R2_BUCKET_NAME}"
  echo "  Allowed Origin: ${APP_ORIGIN}"
  echo "  Allowed Methods: PUT"
  echo "  Allowed Headers: * (wildcard — presigned URL signature enforces auth)"
  echo "  Expose Headers: ETag"
else
  echo "::error::Failed to configure R2 CORS (HTTP ${RESPONSE})"
  echo "Response: ${BODY}"
  exit 1
fi
