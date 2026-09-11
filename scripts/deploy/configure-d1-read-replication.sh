#!/usr/bin/env bash
#
# Enable D1 read replication (`mode: auto`) on the deployment's D1 databases.
#
# Why this is a deploy step and not a Pulumi property
# ---------------------------------------------------
# `infra/resources/database.ts` keeps `ignoreChanges: ["readReplication"]` on both
# `cloudflare.D1Database` resources. Setting `readReplication` in Pulumi instead would put a
# diff on a live production D1, and the blast radius of the provider choosing to REPLACE that
# resource is total, irreversible data loss (`.claude/rules/31-migration-safety.md`). This
# script is the safe half of that split ownership: it only ever PUTs the one field, and
# `read_replication` is the ONLY field the D1 update endpoint accepts, so it cannot clobber
# the database's name or jurisdiction.
#
# Idempotent: reads the current mode first and skips when it already matches, so a clean
# install and an upgrade behave identically (project policy 7d24e435).
#
# Why enabling it is safe on its own: without the Sessions API every query still goes to the
# primary, so turning replication on changes nothing until `apps/api/src/lib/d1-session.ts`
# opens a session — and that code works against a database with replication disabled too.
# The two halves can therefore deploy in either order.
#
# Required environment variables:
#   CF_API_TOKEN               — Cloudflare API token (needs D1:Edit; the deploy token already
#                                has it, since Pulumi creates these databases)
#   CF_ACCOUNT_ID              — Cloudflare account ID
#   D1_DATABASE_IDS            — space-separated list of D1 database UUIDs
#
# Optional:
#   D1_READ_REPLICATION_MODE   — 'auto' (default) or 'disabled'
#
# Usage: bash scripts/deploy/configure-d1-read-replication.sh
#
set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'

MODE="${D1_READ_REPLICATION_MODE:-auto}"

if [[ "$MODE" != "auto" ]] && [[ "$MODE" != "disabled" ]]; then
  echo "::error::D1_READ_REPLICATION_MODE must be 'auto' or 'disabled' (got '${MODE}')" >&2
  exit 1
fi

MISSING=""
for VAR in CF_API_TOKEN CF_ACCOUNT_ID D1_DATABASE_IDS; do
  if [[ -z "${!VAR:-}" ]]; then
    MISSING="$MISSING $VAR"
  fi
done

if [[ -n "$MISSING" ]]; then
  echo "::error::D1 read replication configuration failed — missing required env vars:${MISSING}." >&2
  exit 1
fi

API_BASE="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database"

# Bounded on both ends so a connection that opens but never answers cannot hang the deploy
# until the workflow-level timeout. Applied to every Cloudflare call in this script.
CURL_OPTIONS=(--silent --show-error --connect-timeout 10 --max-time 60)

# Extract read_replication.mode from a Cloudflare API envelope without needing jq's presence
# to be assumed; jq is available on GitHub runners and in the devcontainer.
read_current_mode() {
  local database_id="$1"
  local response
  response=$(curl "${CURL_OPTIONS[@]}" -H "Authorization: Bearer ${CF_API_TOKEN}" "${API_BASE}/${database_id}")
  if [[ "$(printf '%s' "$response" | jq -r '.success // false')" != "true" ]]; then
    # stderr, not stdout: this function runs inside a command substitution, so anything on
    # stdout is captured as the mode instead of surfacing as a deploy annotation.
    echo "::error::Failed to read D1 database ${database_id}: $(printf '%s' "$response" | jq -c '.errors // .' 2>/dev/null || printf '%s' "$response")" >&2
    return 1
  fi
  printf '%s' "$response" | jq -r '.result.read_replication.mode // "unknown"'
}

# Reject anything that is not a UUID. A `pulumi stack output` that silently produced an empty
# string would otherwise collapse the loop to zero iterations and report success, which is the
# "silence is not success" failure mode in `.claude/rules/53`.
DATABASE_COUNT=0
for DATABASE_ID in ${D1_DATABASE_IDS}; do
  if ! printf '%s' "$DATABASE_ID" | grep -Eq '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'; then
    echo "::error::Refusing to configure D1 read replication — '${DATABASE_ID}' is not a database UUID" >&2
    exit 1
  fi
  DATABASE_COUNT=$((DATABASE_COUNT + 1))
done

if [[ "$DATABASE_COUNT" -eq 0 ]]; then
  echo "::error::D1_DATABASE_IDS resolved to no database IDs" >&2
  exit 1
fi

CHANGED=0
for DATABASE_ID in ${D1_DATABASE_IDS}; do
  CURRENT=$(read_current_mode "$DATABASE_ID")

  if [[ "$CURRENT" = "$MODE" ]]; then
    echo "D1 ${DATABASE_ID}: read replication already '${MODE}' — skipping"
    continue
  fi

  echo "D1 ${DATABASE_ID}: read replication '${CURRENT}' -> '${MODE}'"
  STATUS=$(curl "${CURL_OPTIONS[@]}" -o /tmp/d1-read-replication-response.json -w "%{http_code}" \
    -X PUT "${API_BASE}/${DATABASE_ID}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"read_replication\":{\"mode\":\"${MODE}\"}}")

  BODY=$(cat /tmp/d1-read-replication-response.json 2>/dev/null || echo "(empty)")
  rm -f /tmp/d1-read-replication-response.json

  if [[ "$STATUS" -lt 200 ]] || [[ "$STATUS" -ge 300 ]]; then
    echo "::error::Failed to set D1 read replication on ${DATABASE_ID} (HTTP ${STATUS})" >&2
    echo "Response: ${BODY}"
    exit 1
  fi

  # Verify the DEPLOYED value rather than trusting the write
  # (`.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`).
  APPLIED=$(printf '%s' "$BODY" | jq -r '.result.read_replication.mode // "unknown"')
  if [[ "$APPLIED" != "$MODE" ]]; then
    echo "::error::D1 ${DATABASE_ID} reported read replication '${APPLIED}' after requesting '${MODE}'" >&2
    exit 1
  fi

  echo -e "${GREEN}D1 ${DATABASE_ID}: read replication is now '${APPLIED}'${NC}"
  CHANGED=$((CHANGED + 1))
done

echo "D1 read replication configured (mode='${MODE}', ${CHANGED} of ${DATABASE_COUNT} database(s) changed)"
