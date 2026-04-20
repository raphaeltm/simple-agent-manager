#!/bin/bash
# Configure worker secrets with proper error handling

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

read_pulumi_secret() {
  local output_name="$1"
  if [ -z "${PULUMI_STACK:-}" ]; then
    return 0
  fi

  (
    cd infra
    pulumi stack select "$PULUMI_STACK" >/dev/null 2>&1
    pulumi stack output "$output_name" --show-secrets 2>/dev/null
  ) || true
}

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

if [ -z "$PULUMI_ENCRYPTION_KEY" ] && [ -n "${PULUMI_STACK:-}" ]; then
  echo "Reading Pulumi-managed security keys from stack: $PULUMI_STACK"
  PULUMI_ENCRYPTION_KEY="$(read_pulumi_secret encryptionKey)"
  PULUMI_JWT_PRIVATE_KEY="$(read_pulumi_secret jwtPrivateKey)"
  PULUMI_JWT_PUBLIC_KEY="$(read_pulumi_secret jwtPublicKey)"
fi

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
if [ -z "$PULUMI_ORIGIN_CA_CERT" ] && [ -n "${PULUMI_STACK:-}" ]; then
  PULUMI_ORIGIN_CA_CERT="$(read_pulumi_secret originCaCertPem)"
  PULUMI_ORIGIN_CA_KEY="$(read_pulumi_secret originCaKeyPem)"
fi
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

# Configure analytics forwarding secrets (optional — only needed for external event forwarding)
SEGMENT_WRITE_KEY="${SEGMENT_WRITE_KEY:-}"
if [ -n "$SEGMENT_WRITE_KEY" ]; then
  set_worker_secret "SEGMENT_WRITE_KEY" "$SEGMENT_WRITE_KEY" "$ENVIRONMENT" "false"
else
  echo -e "${YELLOW}ℹ  Skipping SEGMENT_WRITE_KEY (not set — Segment analytics forwarding disabled)${NC}"
fi

GA4_API_SECRET="${GA4_API_SECRET:-}"
GA4_MEASUREMENT_ID="${GA4_MEASUREMENT_ID:-}"
if [ -n "$GA4_API_SECRET" ] && [ -n "$GA4_MEASUREMENT_ID" ]; then
  set_worker_secret "GA4_API_SECRET" "$GA4_API_SECRET" "$ENVIRONMENT" "false"
  set_worker_secret "GA4_MEASUREMENT_ID" "$GA4_MEASUREMENT_ID" "$ENVIRONMENT" "false"
else
  echo -e "${YELLOW}ℹ  Skipping GA4 secrets (GA4_API_SECRET/GA4_MEASUREMENT_ID not set — GA4 analytics forwarding disabled)${NC}"
fi

# Configure smoke test auth (optional — only needed for staging/test environments)
SMOKE_TEST_AUTH_ENABLED="${SMOKE_TEST_AUTH_ENABLED:-}"
if [ -n "$SMOKE_TEST_AUTH_ENABLED" ]; then
  set_worker_secret "SMOKE_TEST_AUTH_ENABLED" "$SMOKE_TEST_AUTH_ENABLED" "$ENVIRONMENT" "false"
else
  echo -e "${YELLOW}ℹ  Skipping SMOKE_TEST_AUTH_ENABLED (not set — smoke test token auth disabled)${NC}"
fi

# Configure Anthropic API key (optional — needed for Claude models in AI proxy)
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
if [ -n "$ANTHROPIC_API_KEY" ]; then
  set_worker_secret "ANTHROPIC_API_KEY" "$ANTHROPIC_API_KEY" "$ENVIRONMENT" "false"
else
  echo -e "${YELLOW}ℹ  Skipping ANTHROPIC_API_KEY (not set — Claude models in AI proxy disabled, will fall back to Workers AI)${NC}"
fi

# NOTE: Hetzner tokens are NOT platform secrets.
# Users provide their own tokens through the Settings UI, stored encrypted per-user in the database.

# ========================================
# Stale Secret Cleanup
# ========================================
# When configuration is migrated from secrets to [vars] in wrangler.toml,
# old secrets shadow the new vars (secrets take precedence). Delete them.
STALE_SECRETS=(
  "AI_PROXY_DEFAULT_MODEL"   # Migrated to wrangler.toml [vars] — code defaults in shared/constants/ai-services.ts
  "AI_PROXY_ENABLED"         # Migrated to wrangler.toml [vars]
)

echo ""
echo "Cleaning up stale secrets (migrated to wrangler.toml vars)..."
for secret_name in "${STALE_SECRETS[@]}"; do
  if output=$(echo "y" | pnpm --filter @simple-agent-manager/api exec wrangler secret delete "$secret_name" --env "$ENVIRONMENT" 2>&1); then
    echo -e "${GREEN}  Deleted stale secret: $secret_name${NC}"
  else
    # Wrangler exits non-zero if the secret doesn't exist — that's fine
    if echo "$output" | grep -qi "not found\|does not exist\|couldn't find"; then
      echo -e "  $secret_name not present (OK)"
    else
      # Unexpected error — log but don't fail the deploy
      echo -e "${YELLOW}  Could not delete $secret_name: $output${NC}"
    fi
  fi
done

echo ""
if [ "$FAILED" = "true" ]; then
  echo -e "${RED}❌ Some required secrets failed to configure${NC}"
  exit 1
else
  echo -e "${GREEN}✅ All secrets configured successfully${NC}"
fi
