#!/usr/bin/env bash
# Verify and activate a Cloudflare Pages custom domain.
#
# After Pulumi creates a PagesDomain resource, the domain may stay in
# "initializing" state because SSL certificate provisioning hasn't completed.
# This script:
#   1. Checks the domain status via Cloudflare API
#   2. PATCHes to retry validation if stuck
#   3. Polls until active (or times out with diagnostic logs)
#
# Required env vars:
#   CF_ACCOUNT_ID  - Cloudflare account ID
#   CF_API_TOKEN   - API token with Pages:Edit permission
#   PAGES_PROJECT  - Pages project name (e.g. "sam-web-staging")
#   PAGES_DOMAIN   - Custom domain (e.g. "app.sammy.party")
#
# Optional env vars:
#   POLL_TIMEOUT_SECONDS  - Max time to poll (default: 120)
#   POLL_INTERVAL_SECONDS - Time between polls (default: 10)

set -euo pipefail

: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID is required}"
: "${CF_API_TOKEN:?CF_API_TOKEN is required}"
: "${PAGES_PROJECT:?PAGES_PROJECT is required}"
: "${PAGES_DOMAIN:?PAGES_DOMAIN is required}"

POLL_TIMEOUT="${POLL_TIMEOUT_SECONDS:-120}"
POLL_INTERVAL="${POLL_INTERVAL_SECONDS:-10}"
API_BASE="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}/domains"

log() { echo "[pages-domain] $*"; }
log_group() { echo "::group::$*"; }
log_endgroup() { echo "::endgroup::"; }

# Fetch domain status from Cloudflare API
get_domain_status() {
  local response
  response=$(curl -sf \
    "${API_BASE}/${PAGES_DOMAIN}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" 2>&1) || {
    echo "API_ERROR"
    return
  }
  echo "$response"
}

# Extract status field from API response
parse_status() {
  local response="$1"
  if [ "$response" = "API_ERROR" ]; then
    echo "api_error"
    return
  fi
  echo "$response" | python3 -c "import sys, json; r=json.load(sys.stdin); print(r.get('result',{}).get('status','unknown'))" 2>/dev/null || echo "parse_error"
}

# Log full diagnostic info from API response
log_diagnostics() {
  local response="$1"
  local label="$2"
  if [ "$response" = "API_ERROR" ]; then
    log "  $label: API call failed"
    return
  fi
  python3 -c "
import sys, json
r = json.load(sys.stdin)
result = r.get('result', {})
print(f'  Status:      {result.get(\"status\", \"unknown\")}')
vd = result.get('validation_data', {})
if vd:
    print(f'  Validation:  status={vd.get(\"status\",\"?\")} method={vd.get(\"method\",\"?\")} error={vd.get(\"error_message\",\"\")}')
vr = result.get('verification_data', {})
if vr:
    print(f'  Verification: status={vr.get(\"status\",\"?\")} error={vr.get(\"error_message\",\"\")}')
cert = result.get('certificate_authority', '')
if cert:
    print(f'  Cert CA:     {cert}')
" <<< "$response" 2>/dev/null || log "  $label: Could not parse response"
}

# PATCH to retry domain validation
retry_validation() {
  log "Sending PATCH to retry domain validation..."
  local response
  response=$(curl -s -w "\n%{http_code}" -X PATCH \
    "${API_BASE}/${PAGES_DOMAIN}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{}' 2>&1)

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    log "PATCH succeeded (HTTP ${http_code})"
  else
    log "::warning::PATCH failed (HTTP ${http_code}): ${body}"
  fi
}

# Test ACME challenge path reachability
test_acme_path() {
  log "Testing ACME challenge path reachability..."
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://${PAGES_DOMAIN}/.well-known/acme-challenge/test-probe" 2>/dev/null || echo "000")

  if [ "$http_code" = "000" ]; then
    log "  ACME path: DNS not resolving or connection failed"
  elif [ "$http_code" = "404" ]; then
    log "  ACME path: Reachable (404 expected for test probe)"
  else
    log "  ACME path: HTTP ${http_code} (may indicate Worker route interception)"
  fi
}

# ---- Main ----

log "Verifying Pages custom domain: ${PAGES_DOMAIN}"
log "  Project: ${PAGES_PROJECT}"
log "  Timeout: ${POLL_TIMEOUT}s (interval: ${POLL_INTERVAL}s)"
echo ""

# Initial check
log_group "Initial domain status"
response=$(get_domain_status)
status=$(parse_status "$response")
log_diagnostics "$response" "Initial"
test_acme_path
log_endgroup

if [ "$status" = "active" ]; then
  log "Domain is active. No action needed."
  exit 0
fi

if [ "$status" = "api_error" ]; then
  # Domain might not exist yet (Pulumi may not have created it)
  log "::warning::Could not fetch domain status. The domain may not be registered on the Pages project yet."
  log "Check: CF Dashboard > Workers & Pages > ${PAGES_PROJECT} > Custom Domains"
  exit 0
fi

# Domain exists but not active — retry validation
log "Domain status: ${status}. Retrying validation..."
retry_validation

# Poll for activation
elapsed=0
while [ "$elapsed" -lt "$POLL_TIMEOUT" ]; do
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))

  response=$(get_domain_status)
  status=$(parse_status "$response")

  log "Poll ${elapsed}s/${POLL_TIMEOUT}s: status=${status}"

  if [ "$status" = "active" ]; then
    log "Domain activated successfully after ${elapsed}s."
    log_group "Final domain status"
    log_diagnostics "$response" "Active"
    log_endgroup
    exit 0
  fi

  if [ "$status" = "error" ] || [ "$status" = "blocked" ]; then
    log "::warning::Domain in ${status} state — manual intervention may be required."
    log_group "Error diagnostics"
    log_diagnostics "$response" "Error"
    test_acme_path
    log_endgroup
    # Retry once more
    retry_validation
  fi
done

# Timed out
log "::warning::Domain did not activate within ${POLL_TIMEOUT}s (final status: ${status})."
log "This is often a first-deploy timing issue. The domain may activate shortly."
log ""
log_group "Timeout diagnostics"
response=$(get_domain_status)
log_diagnostics "$response" "Timeout"
test_acme_path

# List all domains on the project for debugging
log ""
log "All domains on ${PAGES_PROJECT}:"
curl -s "${API_BASE}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" | \
  python3 -c "
import sys, json
r = json.load(sys.stdin)
for d in r.get('result', []):
    print(f'  {d.get(\"name\",\"?\")} -> status={d.get(\"status\",\"?\")}')
" 2>/dev/null || log "  Could not list domains"
log_endgroup

# Non-blocking — the domain may activate later
log ""
log "Continuing deployment. The domain may activate after Worker routes are deployed."
log "If it stays stuck, check: https://developers.cloudflare.com/pages/configuration/custom-domains/#troubleshooting"
exit 0
