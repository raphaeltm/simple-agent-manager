#!/usr/bin/env bash
# Explicit publication only. Never called implicitly by installing a runtime.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <reviewed-runtime.tar.gz>" >&2; exit 2; }
: "${R2_BUCKET:?R2_BUCKET is required}"
[[ "$R2_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || exit 1
release='1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95'
size=136245837
# Pinned Wrangler R2 REST upload transport rejects objects above 300 MiB.
(( size <= 300 * 1024 * 1024 )) || { echo 'Artifact exceeds Wrangler upload limit' >&2; exit 1; }
private=$(mktemp -d)
trap 'rm -rf -- "$private"' EXIT
timeout 120 head -c "$((size + 1))" -- "$1" > "$private/runtime.tar"
[[ $(stat -c %s "$private/runtime.tar") == "$size" ]]
printf '%s  %s\n' "$release" "$private/runtime.tar" | sha256sum --check --status
object="$R2_BUCKET/acp/codex/releases/$release/codex-runtime-linux-amd64.tar.gz"
if result=$(timeout 180 pnpm --filter @simple-agent-manager/api exec wrangler r2 object get "$object" --file "$private/existing.tar" --remote 2>&1); then
  printf '%s  %s\n' "$release" "$private/existing.tar" | sha256sum --check --status
  echo 'Reusing identical immutable Codex runtime artifact'
  exit 0
fi
# Only an explicit missing-key response permits publication; auth/network errors
# must not be mistaken for absence. Do not print arbitrary provider error text.
if [[ "$result" != *'The specified key does not exist.'* ]]; then
  echo 'Cannot establish immutable artifact absence' >&2; exit 1
fi
timeout 180 pnpm --filter @simple-agent-manager/api exec wrangler r2 object put "$object" --file "$private/runtime.tar" --remote
timeout 180 pnpm --filter @simple-agent-manager/api exec wrangler r2 object get "$object" --file "$private/published.tar" --remote
printf '%s  %s\n' "$release" "$private/published.tar" | sha256sum --check --status
echo 'Published and read-back verified immutable Codex runtime artifact'
