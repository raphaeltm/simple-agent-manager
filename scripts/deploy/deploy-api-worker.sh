#!/usr/bin/env bash
set -euo pipefail

DO_MIGRATION_BACKEND_ENV="SAM_DO_MIGRATION_BACKEND"
DO_SQLITE_BACKEND="sqlite"
FREE_PLAN_DO_ERROR_PATTERN="new_sqlite_classes migration"
FREE_PLAN_DO_ERROR_CODE="code: 10097"
NON_INHERITED_BINDINGS_PATTERN="not inherited by environments"
CLOUDFLARE_WORKERS_API_BASE="${CLOUDFLARE_WORKERS_API_BASE:-https://api.cloudflare.com/client/v4}"

DEPLOY_OUTPUT=""

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "::error::$name is required"
    exit 1
  fi
}

cloudflare_api_token() {
  if [ -n "${CF_API_TOKEN:-}" ]; then
    printf '%s' "$CF_API_TOKEN"
    return
  fi

  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    printf '%s' "$CLOUDFLARE_API_TOKEN"
    return
  fi

  echo "::error::CF_API_TOKEN or CLOUDFLARE_API_TOKEN is required"
  exit 1
}

run_api_worker_deploy() {
  set +e
  DEPLOY_OUTPUT=$(pnpm --filter @simple-agent-manager/api exec wrangler deploy --env "$DEPLOY_ENV" 2>&1)
  local status=$?

  printf '%s\n' "$DEPLOY_OUTPUT"
  return "$status"
}

assert_no_non_inherited_bindings() {
  if grep -q "$NON_INHERITED_BINDINGS_PATTERN" <<<"$DEPLOY_OUTPUT"; then
    echo ""
    echo "::error::Wrangler detected non-inherited bindings. Check sync-wrangler-config.ts."
    echo "See: .claude/rules/07-env-and-urls.md"
    exit 1
  fi
}

is_free_plan_do_error() {
  grep -q "$FREE_PLAN_DO_ERROR_PATTERN" <<<"$DEPLOY_OUTPUT" ||
    grep -q "$FREE_PLAN_DO_ERROR_CODE" <<<"$DEPLOY_OUTPUT"
}

api_worker_exists() {
  require_env "CF_ACCOUNT_ID"
  require_env "API_WORKER_NAME"

  local token
  token=$(cloudflare_api_token)
  local body_file
  body_file=$(mktemp)
  local http_code

  set +e
  http_code=$(
    curl -sS -o "$body_file" -w "%{http_code}" \
      -H "Authorization: Bearer ${token}" \
      "${CLOUDFLARE_WORKERS_API_BASE}/accounts/${CF_ACCOUNT_ID}/workers/scripts/${API_WORKER_NAME}"
  )
  local curl_status=$?
  set -e

  if [ "$curl_status" -ne 0 ]; then
    rm -f "$body_file"
    echo "::error::Failed to check whether API Worker '${API_WORKER_NAME}' exists"
    exit 1
  fi

  case "$http_code" in
    200)
      rm -f "$body_file"
      return 0
      ;;
    404)
      rm -f "$body_file"
      return 1
      ;;
    *)
      echo "::error::Unexpected Cloudflare API response while checking API Worker '${API_WORKER_NAME}' (HTTP ${http_code})"
      cat "$body_file"
      rm -f "$body_file"
      exit 1
      ;;
  esac
}

enable_sqlite_migration_backend() {
  export "${DO_MIGRATION_BACKEND_ENV}=${DO_SQLITE_BACKEND}"

  if [ -n "${GITHUB_ENV:-}" ]; then
    printf '%s=%s\n' "$DO_MIGRATION_BACKEND_ENV" "$DO_SQLITE_BACKEND" >>"$GITHUB_ENV"
  fi
}

sync_wrangler_config() {
  pnpm tsx scripts/deploy/sync-wrangler-config.ts
}

main() {
  require_env "DEPLOY_ENV"

  set +e
  run_api_worker_deploy
  local deploy_status=$?
  set -e

  if [ "$deploy_status" -eq 0 ]; then
    assert_no_non_inherited_bindings
    exit 0
  fi

  if ! is_free_plan_do_error; then
    exit "$deploy_status"
  fi

  echo ""
  echo "Cloudflare rejected legacy Durable Object namespace creation on this plan."
  echo "Checking whether '${API_WORKER_NAME:-<unset>}' is an existing API Worker before retrying with SQLite-backed namespaces."

  if api_worker_exists; then
    echo "::error::Cloudflare returned 10097 but API Worker '${API_WORKER_NAME}' already exists. Existing KV-backed Durable Object namespaces cannot be converted to SQLite in place. Keep this deployment on a Workers Paid plan, or recreate the Worker and Durable Object namespaces for a fresh SQLite-backed install."
    exit 1
  fi

  echo "API Worker '${API_WORKER_NAME}' does not exist. Treating this as a fresh deploy and retrying with ${DO_MIGRATION_BACKEND_ENV}=sqlite."
  enable_sqlite_migration_backend
  sync_wrangler_config

  set +e
  run_api_worker_deploy
  deploy_status=$?
  set -e

  if [ "$deploy_status" -eq 0 ]; then
    assert_no_non_inherited_bindings
    exit 0
  fi

  exit "$deploy_status"
}

main "$@"
