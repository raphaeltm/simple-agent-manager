#!/bin/bash
# Configure worker secrets with proper error handling

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to set a secret with proper error handling
set_worker_secret() {
  local secret_name="$1"
  local secret_value="$2"
  local environment="$3"
  local is_required="${4:-false}"

  if [ -z "$secret_value" ]; then
    if [ "$is_required" = "true" ]; then
      echo -e "${RED}❌ Required secret $secret_name is not set${NC}"
      return 1
    else
      echo -e "${YELLOW}⚠️  Optional secret $secret_name is not set, skipping${NC}"
      return 0
    fi
  fi

  echo -n "Setting $secret_name... "

  # Try to set the secret and capture the output
  if output=$(echo "$secret_value" | pnpm --filter @simple-agent-manager/api exec wrangler secret put "$secret_name" --env "$environment" 2>&1); then
    echo -e "${GREEN}✅${NC}"
    return 0
  else
    # Check if it's an "already exists" error
    if echo "$output" | grep -q "already exists\|already set"; then
      echo -e "${GREEN}✅ (already exists)${NC}"
      return 0
    else
      echo -e "${RED}❌${NC}"
      echo "Error: $output"
      return 1
    fi
  fi
}

# Parse arguments
ENVIRONMENT="${1:-production}"

# Security keys from different sources
# Priority: GitHub secrets (backwards compat) > Pulumi state (primary) > Generated (legacy)
PULUMI_ENCRYPTION_KEY="${PULUMI_ENCRYPTION_KEY:-}"
PULUMI_JWT_PRIVATE_KEY="${PULUMI_JWT_PRIVATE_KEY:-}"
PULUMI_JWT_PUBLIC_KEY="${PULUMI_JWT_PUBLIC_KEY:-}"
SECRET_ENCRYPTION_KEY="${SECRET_ENCRYPTION_KEY:-}"
SECRET_JWT_PRIVATE_KEY="${SECRET_JWT_PRIVATE_KEY:-}"
SECRET_JWT_PUBLIC_KEY="${SECRET_JWT_PUBLIC_KEY:-}"

echo "Configuring secrets for environment: $ENVIRONMENT"
echo ""

# Determine key source with priority:
# 1. GitHub secrets (backwards compatibility for existing deployments)
# 2. Pulumi state (primary source, persists automatically)
if [ -n "$SECRET_ENCRYPTION_KEY" ]; then
  echo "Using security keys from GitHub Secrets (backwards compatibility)"
  ENCRYPTION_KEY="$SECRET_ENCRYPTION_KEY"
  JWT_PRIVATE_KEY="$SECRET_JWT_PRIVATE_KEY"
  JWT_PUBLIC_KEY="$SECRET_JWT_PUBLIC_KEY"
elif [ -n "$PULUMI_ENCRYPTION_KEY" ]; then
  echo "Using security keys from Pulumi state (auto-persisted)"
  ENCRYPTION_KEY="$PULUMI_ENCRYPTION_KEY"
  JWT_PRIVATE_KEY="$PULUMI_JWT_PRIVATE_KEY"
  JWT_PUBLIC_KEY="$PULUMI_JWT_PUBLIC_KEY"
else
  echo -e "${RED}ERROR: No security keys available from GitHub Secrets or Pulumi state${NC}"
  echo "This should not happen - Pulumi should have created the keys."
  exit 1
fi
echo ""

# Track if any required secrets fail
FAILED=false

# Configure required security secrets
set_worker_secret "ENCRYPTION_KEY" "$ENCRYPTION_KEY" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "JWT_PRIVATE_KEY" "$JWT_PRIVATE_KEY" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "JWT_PUBLIC_KEY" "$JWT_PUBLIC_KEY" "$ENVIRONMENT" "true" || FAILED=true

# Configure purpose-specific secret overrides (optional — fall back to ENCRYPTION_KEY)
# When set, these isolate each security domain so compromise of one doesn't affect the others.
set_worker_secret "BETTER_AUTH_SECRET" "${BETTER_AUTH_SECRET:-}" "$ENVIRONMENT" "false"
set_worker_secret "CREDENTIAL_ENCRYPTION_KEY" "${CREDENTIAL_ENCRYPTION_KEY:-}" "$ENVIRONMENT" "false"
set_worker_secret "GITHUB_WEBHOOK_SECRET" "${GITHUB_WEBHOOK_SECRET:-}" "$ENVIRONMENT" "false"

# Configure Cloudflare secrets (required for DNS and observability operations)
set_worker_secret "CF_API_TOKEN" "${CF_API_TOKEN:-}" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "CF_ZONE_ID" "${CF_ZONE_ID:-}" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "CF_ACCOUNT_ID" "${CF_ACCOUNT_ID:-}" "$ENVIRONMENT" "true" || FAILED=true

# Configure GitHub secrets (required - platform is useless without authentication)
# GH_* env vars (GitHub Actions reserves GITHUB_*) are mapped to GITHUB_* Worker secrets.
# See CLAUDE.md "Env Var Naming: GH_ vs GITHUB_" and .claude/rules/07-env-and-urls.md.
set_worker_secret "GITHUB_CLIENT_ID" "${GH_CLIENT_ID:-}" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "GITHUB_CLIENT_SECRET" "${GH_CLIENT_SECRET:-}" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "GITHUB_APP_ID" "${GH_APP_ID:-}" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "GITHUB_APP_PRIVATE_KEY" "${GH_APP_PRIVATE_KEY:-}" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "GITHUB_APP_SLUG" "${GH_APP_SLUG:-}" "$ENVIRONMENT" "true" || FAILED=true

# Configure Origin CA certificate/key (required for TLS between CF edge and VM agents)
PULUMI_ORIGIN_CA_CERT="${PULUMI_ORIGIN_CA_CERT:-}"
PULUMI_ORIGIN_CA_KEY="${PULUMI_ORIGIN_CA_KEY:-}"
set_worker_secret "ORIGIN_CA_CERT" "$PULUMI_ORIGIN_CA_CERT" "$ENVIRONMENT" "true" || FAILED=true
set_worker_secret "ORIGIN_CA_KEY" "$PULUMI_ORIGIN_CA_KEY" "$ENVIRONMENT" "true" || FAILED=true

# Configure Google OAuth secrets (optional — only needed for GCP OIDC integration)
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
if [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; then
  set_worker_secret "GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_ID" "$ENVIRONMENT" "true" || FAILED=true
  set_worker_secret "GOOGLE_CLIENT_SECRET" "$GOOGLE_CLIENT_SECRET" "$ENVIRONMENT" "true" || FAILED=true
else
  echo -e "${YELLOW}ℹ  Skipping Google OAuth secrets (GOOGLE_CLIENT_ID/SECRET not set — GCP OIDC integration disabled)${NC}"
fi

# Configure R2 S3-compatible API credentials (optional — only needed for task attachment uploads)
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
if [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ]; then
  set_worker_secret "R2_ACCESS_KEY_ID" "$R2_ACCESS_KEY_ID" "$ENVIRONMENT" "true" || FAILED=true
  set_worker_secret "R2_SECRET_ACCESS_KEY" "$R2_SECRET_ACCESS_KEY" "$ENVIRONMENT" "true" || FAILED=true
else
  echo -e "${YELLOW}ℹ  Skipping R2 S3 credentials (R2_ACCESS_KEY_ID/SECRET not set — task attachment uploads disabled)${NC}"
fi

# Configure smoke test auth (optional — only needed for staging/test environments)
SMOKE_TEST_AUTH_ENABLED="${SMOKE_TEST_AUTH_ENABLED:-}"
if [ -n "$SMOKE_TEST_AUTH_ENABLED" ]; then
  set_worker_secret "SMOKE_TEST_AUTH_ENABLED" "$SMOKE_TEST_AUTH_ENABLED" "$ENVIRONMENT" "false"
else
  echo -e "${YELLOW}ℹ  Skipping SMOKE_TEST_AUTH_ENABLED (not set — smoke test token auth disabled)${NC}"
fi

# NOTE: Hetzner tokens are NOT platform secrets.
# Users provide their own tokens through the Settings UI, stored encrypted per-user in the database.

echo ""
if [ "$FAILED" = "true" ]; then
  echo -e "${RED}❌ Some required secrets failed to configure${NC}"
  exit 1
else
  echo -e "${GREEN}✅ All secrets configured successfully${NC}"
fi