#!/usr/bin/env bash
#
# Configure R2 bucket CORS rules for direct browser uploads.
# Uses the AWS CLI (pre-installed on GitHub Actions runners) with S3-compatible API.
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

GREEN='\033[0;32m'
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
# Configure CORS using AWS CLI (S3-compatible API)
# ---------------------------------------------------------------------------
APP_ORIGIN="https://app.${BASE_DOMAIN}"
R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"

echo "Configuring R2 CORS for bucket '${R2_BUCKET_NAME}' (origin: ${APP_ORIGIN})..."

# Only PUT is allowed — all R2 reads flow through the authenticated Worker proxy.
# Omitting GET prevents leaked presigned GET URLs from being usable cross-origin.
# AllowedHeaders wildcard is safe: presigned URL signature enforces authorization.
CORS_CONFIG=$(cat <<CORSEOF
{
  "CORSRules": [
    {
      "AllowedOrigins": ["${APP_ORIGIN}"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
CORSEOF
)

AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
aws s3api put-bucket-cors \
  --bucket "${R2_BUCKET_NAME}" \
  --cors-configuration "${CORS_CONFIG}" \
  --endpoint-url "${R2_ENDPOINT}" \
  --region auto

echo -e "${GREEN}R2 CORS configured successfully${NC}"
echo "  Bucket: ${R2_BUCKET_NAME}"
echo "  Allowed Origin: ${APP_ORIGIN}"
echo "  Allowed Methods: PUT"
echo "  Allowed Headers: * (wildcard — presigned URL signature enforces auth)"
echo "  Expose Headers: ETag"
