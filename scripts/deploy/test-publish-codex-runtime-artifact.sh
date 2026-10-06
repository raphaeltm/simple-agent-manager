#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || exit 2
archive=$(realpath "$1")
scripts=$(cd "$(dirname "$0")" && pwd -P)
private=$(mktemp -d)
trap 'rm -rf "$private"' EXIT
mkdir "$private/bin" "$private/state"
cat > "$private/bin/pnpm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3 $4 $5 $6" == '--filter @simple-agent-manager/api exec wrangler r2 object' ]]
operation=$7
[[ "$8" == test-bucket/acp/codex/releases/1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95/codex-runtime-linux-amd64.tar.gz ]]
[[ "$9" == --file && "${11}" == --remote ]]
echo "$operation" >> "$FAKE_STATE/calls"
if [[ "$FAKE_CASE" == unavailable ]]; then echo 'service unavailable' >&2; exit 1; fi
if [[ "$operation" == put ]]; then
  (( $(stat -c %s "${10}") <= 300 * 1024 * 1024 )) || { echo 'Wrangler upload size limit' >&2; exit 1; }
  if [[ "$FAKE_CASE" == corrupt ]]; then printf wrong > "$FAKE_STATE/object";
  else cp --reflink=auto "${10}" "$FAKE_STATE/object"; fi
elif [[ -e "$FAKE_STATE/object" ]]; then
  cp --reflink=auto "$FAKE_STATE/object" "${10}"
else
  echo 'The specified key does not exist.' >&2; exit 1
fi
MOCK
chmod +x "$private/bin/pnpm"
export PATH="$private/bin:$PATH" FAKE_STATE="$private/state" R2_BUCKET=test-bucket FAKE_CASE=normal
"$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null
[[ $(cat "$FAKE_STATE/calls") == $'get\nput\nget' ]]
: > "$FAKE_STATE/calls"
"$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null
[[ $(cat "$FAKE_STATE/calls") == get ]]
printf wrong > "$FAKE_STATE/object"
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null 2>&1; then exit 1; fi
[[ $(cat "$FAKE_STATE/calls") == get ]]
rm "$FAKE_STATE/object"
export FAKE_CASE=unavailable
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null 2>&1; then exit 1; fi
[[ $(cat "$FAKE_STATE/calls") == get ]]
export FAKE_CASE=corrupt
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null 2>&1; then exit 1; fi
[[ $(cat "$FAKE_STATE/calls") == $'get\nput\nget' ]]
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$FAKE_STATE/object" >/dev/null 2>&1; then exit 1; fi
[[ ! -s "$FAKE_STATE/calls" ]]
echo 'Immutable publisher: create, reuse, mismatch, lookup failure, corrupt readback, invalid input passed (mock R2 only)'
