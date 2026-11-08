#!/usr/bin/env bash
# Explicit publication only. Never called implicitly by installing a runtime.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <reviewed-runtime.tar.gz>" >&2; exit 2; }
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
[[ "$R2_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || exit 1
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[a-f0-9]{32}$ ]] || exit 1
release='384d0071527848b68df318c04f2e6e040f2eea67131bbd5b6f66cc58f5bd65bd'
size=136243963
# R2's S3 API moves this archive in seconds; Wrangler's REST object transport
# took over 180 s to read it back on an installer builder (2026-11-07).
# 136 MB within 300 s needs only ~0.45 MB/s.
transfer_timeout=${CODEX_PUBLISH_TRANSFER_TIMEOUT_SECONDS:-300}
[[ "$transfer_timeout" =~ ^[1-9][0-9]{0,4}$ ]] || exit 1
private=$(mktemp -d)
trap 'rm -rf -- "$private"' EXIT
timeout 120 head -c "$((size + 1))" -- "$1" > "$private/runtime.tar"
[[ $(stat -c %s "$private/runtime.tar") == "$size" ]]
printf '%s  %s\n' "$release" "$private/runtime.tar" | sha256sum --check --status
# A single-part R2 upload's ETag is the MD5 of the bytes, so a HEAD verifies a
# stored object against the SHA-256-checked local copy without reading it back.
md5=$(md5sum "$private/runtime.tar" | cut -c1-32)
url="https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET/acp/codex/releases/$release/codex-runtime-linux-amd64.tar.gz"
s3() {
  local seconds=$1; shift
  curl --silent --show-error --max-time "$seconds" \
    --aws-sigv4 'aws:amz:auto:s3' --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
    -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' "$@" "$url"
}
# Prints the HTTP status; matching size and ETag are reported as "match".
stored() {
  local status
  status=$(s3 30 --head --output /dev/null --dump-header "$private/headers" --write-out '%{http_code}') || return 1
  if [[ "$status" == 200 ]]; then
    if grep -qix "content-length: $size"$'\r' "$private/headers" &&
      grep -qix "etag: \"$md5\""$'\r' "$private/headers"; then echo match; else echo mismatch; fi
  else
    echo "$status"
  fi
}
case $(stored || echo error) in
  match) echo 'Reusing identical immutable Codex runtime artifact'; exit 0 ;;
  # Only an explicit absence permits publication; auth/network errors must not
  # be mistaken for absence. Provider error text is not printed.
  404) ;;
  mismatch) echo 'Existing Codex runtime artifact does not match the pinned release' >&2; exit 1 ;;
  *) echo 'Cannot establish immutable artifact absence' >&2; exit 1 ;;
esac
s3 "$transfer_timeout" --fail --output /dev/null --upload-file "$private/runtime.tar"
[[ $(stored || echo error) == match ]] || { echo 'Published Codex runtime artifact failed verification' >&2; exit 1; }
echo 'Published and verified immutable Codex runtime artifact'
