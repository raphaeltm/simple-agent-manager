#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || exit 2
archive=$(realpath "$1")
scripts=$(cd "$(dirname "$0")" && pwd -P)
private=$(mktemp -d)
trap 'rm -rf "$private"' EXIT
mkdir "$private/bin" "$private/state"
# Fake R2 S3 endpoint: HEAD reports size and the MD5 ETag of a single-part object.
cat > "$private/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
url=${!#}
[[ "$url" == https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/test-bucket/acp/codex/releases/1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95/codex-runtime-linux-amd64.tar.gz ]]
[[ " $* " == *" --aws-sigv4 aws:amz:auto:s3 "* && " $* " == *" --user test-key:test-secret "* ]]
operation=get headers='' upload=''
while (($#)); do
  case $1 in
    --head) operation=head ;;
    --upload-file) operation=put; upload=$2; shift ;;
    --dump-header) headers=$2; shift ;;
  esac
  shift
done
echo "$operation" >> "$FAKE_STATE/calls"
if [[ "$FAKE_CASE" == unavailable ]]; then printf 503; exit 0; fi
if [[ "$operation" == put ]]; then
  if [[ "$FAKE_CASE" == corrupt ]]; then printf wrong > "$FAKE_STATE/object";
  else cp --reflink=auto "$upload" "$FAKE_STATE/object"; fi
  exit 0
fi
if [[ ! -e "$FAKE_STATE/object" ]]; then printf 404; exit 0; fi
printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\nETag: "%s"\r\n\r\n' \
  "$(stat -c %s "$FAKE_STATE/object")" "$(md5sum "$FAKE_STATE/object" | cut -c1-32)" > "$headers"
printf 200
MOCK
chmod +x "$private/bin/curl"
export PATH="$private/bin:$PATH" FAKE_STATE="$private/state" R2_BUCKET=test-bucket FAKE_CASE=normal \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef AWS_ACCESS_KEY_ID=test-key AWS_SECRET_ACCESS_KEY=test-secret
"$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null
[[ $(cat "$FAKE_STATE/calls") == $'head\nput\nhead' ]]
: > "$FAKE_STATE/calls"
"$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null
[[ $(cat "$FAKE_STATE/calls") == head ]]
printf wrong > "$FAKE_STATE/object"
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null 2>&1; then exit 1; fi
[[ $(cat "$FAKE_STATE/calls") == head ]]
rm "$FAKE_STATE/object"
export FAKE_CASE=unavailable
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null 2>&1; then exit 1; fi
[[ $(cat "$FAKE_STATE/calls") == head ]]
export FAKE_CASE=corrupt
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$archive" >/dev/null 2>&1; then exit 1; fi
[[ $(cat "$FAKE_STATE/calls") == $'head\nput\nhead' ]]
: > "$FAKE_STATE/calls"
if "$scripts/publish-codex-runtime-artifact.sh" "$FAKE_STATE/object" >/dev/null 2>&1; then exit 1; fi
[[ ! -s "$FAKE_STATE/calls" ]]
echo 'Immutable publisher: create, reuse, mismatch, lookup failure, corrupt readback, invalid input passed (mock R2 only)'
