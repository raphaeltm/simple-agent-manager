#!/usr/bin/env bash
# Runs only inside the user-owned managed Debian builder. Never print tool output.
set -euo pipefail
# Tool output is discarded, so name the failing step without echoing command text.
trap 'echo "installer-builder-bootstrap.sh failed at line $LINENO" >&2' ERR
umask 077
: "${SAM_SOURCE_COMMIT:?}" "${SAM_JOB_DIRECTORY:?}"
[[ ${SAM_BUILD_FIT_ONLY:-} == 1 ]] || : "${SAM_ENGINE_CONFIG:?}"
[[ "$SAM_SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ && "$SAM_JOB_DIRECTORY" == /sam/job ]]
# Wrangler 4.149's constructBuildCommand reads this documented-in-source switch
# and supplies --network host to the actual Docker build subprocess.
# https://github.com/cloudflare/workers-sdk/blob/main/packages/containers-shared/src/build.ts
export WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST=1
export DEBIAN_FRONTEND=noninteractive
export CARGO_HOME=/sam/cargo RUSTUP_HOME=/sam/rustup
export PATH=/usr/local/go/bin:/sam/cargo/bin:/root/.pulumi/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p "$SAM_JOB_DIRECTORY"
# OS support packages follow Debian security updates; language/deploy tools are pinned.
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git jq build-essential pkg-config libssl-dev python3 make docker.io docker-cli docker-buildx xz-utils
# Pinned downloads retry across identical versioned sources: one transient CDN
# error (a 404 from dl.google.com on 2026-11-03) must not fail an hour-long build.
# The checksum, not the source, decides acceptance.
fetch_pinned() {
  local output=$1 sha=$2 attempt url
  shift 2
  for attempt in 1 2 3 4; do
    for url in "$@"; do
      if curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 "$url" -o "$output" &&
        printf '%s  %s\n' "$sha" "$output" | sha256sum --check --status; then
        return 0
      fi
      echo "pinned download attempt $attempt failed: $url" >&2
      rm -f "$output"
    done
    sleep $((attempt * ${SAM_FETCH_RETRY_DELAY_SECONDS:-5}))
  done
  return 1
}
fetch_pinned /sam/go.tar.gz ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5 \
  https://dl.google.com/go/go1.26.10.linux-amd64.tar.gz https://go.dev/dl/go1.26.10.linux-amd64.tar.gz
tar -xzf /sam/go.tar.gz -C /usr/local
rm /sam/go.tar.gz
fetch_pinned /sam/rustup-init 5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4 \
  https://static.rust-lang.org/rustup/archive/1.29.2/x86_64-unknown-linux-gnu/rustup-init
chmod 700 /sam/rustup-init
/sam/rustup-init -y --profile minimal --default-toolchain 1.95.0
rm /sam/rustup-init
npm install --global --ignore-scripts pnpm@9.15.9
# Pulumi toolchain download is checksum-pinned below.
fetch_pinned /sam/pulumi.tar.gz 58d545f2b98761051922008ebd381ecef95484d7f7a5ff7faa15d7a780ea84f6 \
  https://github.com/pulumi/pulumi/releases/download/v3.272.0/pulumi-v3.272.0-linux-x64.tar.gz \
  https://get.pulumi.com/releases/sdk/pulumi-v3.272.0-linux-x64.tar.gz
mkdir -p /root/.pulumi/bin
tar -xzf /sam/pulumi.tar.gz --strip-components=1 -C /root/.pulumi/bin
rm /sam/pulumi.tar.gz
dockerd --iptables=false --ip6tables=false --ip-forward=false >/dev/null 2>&1 &
for attempt in $(seq 1 120); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1
docker buildx version >/dev/null
# Full history is required by immutable VM-agent release resolution.
# This remote is fixed in reviewed source; no browser-provided source URL is used.
[[ $(git -C /sam/source rev-parse HEAD) == "$SAM_SOURCE_COMMIT" ]]
[[ $(git -C /sam/source rev-parse --is-shallow-repository) == false ]]
cd /sam/source
pnpm install --frozen-lockfile
# The wrapper controls fixed Codex hooks; public configuration never supplies commands.
if [[ ${SAM_BUILD_FIT_ONLY:-} == 1 ]]; then
  exec bash scripts/deploy/installer-builder-bootstrap-fit.sh
fi
node scripts/deploy/installer-builder-bootstrap-engine.mjs
