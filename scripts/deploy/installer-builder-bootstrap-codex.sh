#!/usr/bin/env bash
# Runtime input identity, not frontend/deployment SHA, owns the immutable cache.
set -euo pipefail
: "${SAM_SOURCE_COMMIT:?}" "${SAM_ARTIFACTS_BUCKET:?}" "${CF_ACCOUNT_ID:?}"
: "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
[[ "$SAM_SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ && "$CF_ACCOUNT_ID" =~ ^[a-f0-9]{32}$ ]]
[[ "$SAM_ARTIFACTS_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]
output=/sam/job/codex
root="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${SAM_ARTIFACTS_BUCKET}/installer"
inputs=$(node scripts/deploy/installer-runtime-identity.mjs inputs . "$SAM_SOURCE_COMMIT")
[[ "$inputs" =~ ^[a-f0-9]{64}$ ]]
base="$root/runtime-inputs/$inputs"
# Keep S3 credentials out of subprocess argv and provider/tool output.
[[ "$R2_ACCESS_KEY_ID" =~ ^[a-f0-9]{32}$ && "$R2_SECRET_ACCESS_KEY" =~ ^[a-f0-9]{64}$ ]]
mkdir -p /sam/private
chmod 700 /sam/private
install -m 0600 /dev/null /sam/private/r2-curl.conf
printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" > /sam/private/r2-curl.conf
trap 'rm -f /sam/private/r2-curl.conf /sam/job/r2-put-response' EXIT
transport=(curl --config /sam/private/r2-curl.conf --silent --show-error --proto '=https' --max-time 600 --aws-sigv4 'aws:amz:auto:s3')
# Compare-and-create every cache/association object; never replace accepted bytes.
immutable_put() {
  local file=$1 url=$2 status
  status=$("${transport[@]}" --request PUT --header 'If-None-Match: *' --upload-file "$file" --output /sam/job/r2-put-response --write-out '%{http_code}' "$url")
  [[ "$status" == 200 || "$status" == 201 || "$status" == 204 || "$status" == 412 ]] || { echo 'Immutable runtime publication failed' >&2; exit 1; }
  "${transport[@]}" --fail --max-filesize 314572800 --output "$file.readback" "$url"
  cmp -- "$file" "$file.readback"
  rm -- "$file.readback"
}
mkdir -p "$output"
association_url="$root/source-runtime/$SAM_SOURCE_COMMIT.json"
association_status=$("${transport[@]}" --max-filesize 4096 --output /sam/job/existing-runtime-association.json --write-out '%{http_code}' "$association_url")
[[ "$association_status" == 200 || "$association_status" == 404 ]] || { echo 'Cannot inspect immutable source association' >&2; exit 1; }
status=$("${transport[@]}" --max-filesize 32768 --output "$output/installation-codex-trust.json" --write-out '%{http_code}' "$base/installation-codex-trust.json")
case "$status" in
  200)
    for name in codex-runtime-linux-amd64.tar.gz install-codex-runtime.sh; do
      "${transport[@]}" --fail --max-filesize 314572800 --output "$output/$name" "$base/$name"
    done
    node scripts/deploy/build-installation-codex-trust.mjs "$output" .
    ;;
  404)
    # Once this source has accepted compiled pins, missing cache is recovery work,
    # never permission to rebuild different bytes under its accepted identity.
    [[ "$association_status" == 404 ]] || { echo 'Accepted runtime cache missing; restore from backup' >&2; exit 1; }
    rm -rf -- "$output"
    previous=()
    if [[ -n ${SAM_PREVIOUS_SOURCE_COMMIT:-} ]]; then
      [[ "$SAM_PREVIOUS_SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]
      "${transport[@]}" --fail --max-filesize 4096 --output /sam/job/previous-runtime-association.json "$root/source-runtime/$SAM_PREVIOUS_SOURCE_COMMIT.json"
      prior_inputs=$(node --input-type=module -e 'import{readFileSync}from"node:fs";const a=JSON.parse(readFileSync("/sam/job/previous-runtime-association.json","utf8"));if(!/^[a-f0-9]{64}$/.test(a.runtimeInputsSHA256))process.exit(1);process.stdout.write(a.runtimeInputsSHA256)')
      "${transport[@]}" --fail --max-filesize 32768 --output /sam/job/previous-codex-trust.json "$root/runtime-inputs/$prior_inputs/installation-codex-trust.json"
      previous=(/sam/job/previous-codex-trust.json)
    fi
    bash scripts/deploy/installer-builder-bootstrap-source-build.sh /sam/job/codex-build "$output" "${previous[@]}"
    # Manifest last; incomplete immutable objects remain reconcilable on retry.
    for name in codex-runtime-linux-amd64.tar.gz install-codex-runtime.sh installation-codex-trust.json; do immutable_put "$output/$name" "$base/$name"; done
    ;;
  *) echo 'Cannot inspect installation runtime cache' >&2; exit 1 ;;
esac
node scripts/deploy/installer-runtime-identity.mjs associate . "$SAM_SOURCE_COMMIT" "$output" .wrangler/installer-runtime-agent-identity.json
if [[ "$association_status" == 200 ]]; then cmp -- /sam/job/existing-runtime-association.json .wrangler/installer-runtime-agent-identity.json; fi
immutable_put .wrangler/installer-runtime-agent-identity.json "$association_url"
mkdir -p apps/api/container-artifacts
install -m 0644 "$output/codex-runtime-linux-amd64.tar.gz" apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz
install -m 0755 "$output/install-codex-runtime.sh" apps/api/container-artifacts/install-codex-runtime.sh
# Only immutable packaged evidence is needed after read-back verification.
rm -rf /sam/job/codex-build /sam/cargo/registry /sam/cargo/git
