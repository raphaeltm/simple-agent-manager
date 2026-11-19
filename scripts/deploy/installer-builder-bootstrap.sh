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
export PATH=/usr/local/go/bin:/root/.pulumi/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p "$SAM_JOB_DIRECTORY"
# OS support packages follow Debian security updates; language/deploy tools are pinned.
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git jq build-essential pkg-config libssl-dev python3 make docker.io docker-cli docker-buildx xz-utils
# Pinned downloads retry across identical versioned sources: one transient CDN
# error (a 404 from dl.google.com on 2026-11-03) must not fail an hour-long build.
# go.dev redirects to dl.google.com, so both URLs share one CDN; it answered the
# Cloudflare builder with 404 for over 20 minutes on 2026-11-07 while serving
# other clients. Go therefore also has a byte-identical SAM prerelease mirror.
# Six attempts with doubling delays (5+10+20+40+60 s by default) ride out about
# two and a half minutes.
# The checksum, not the source, decides acceptance.
fetch_pinned() {
  local output=$1 sha=$2 attempt url delay=${SAM_FETCH_RETRY_DELAY_SECONDS:-5}
  shift 2
  for attempt in $(seq 1 "${SAM_FETCH_ATTEMPTS:-6}"); do
    for url in "$@"; do
      if curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 "$url" -o "$output" &&
        printf '%s  %s\n' "$sha" "$output" | sha256sum --check --status; then
        return 0
      fi
      echo "pinned download attempt $attempt failed: $url" >&2
      rm -f "$output"
    done
    sleep "$delay"
    delay=$(( delay * 2 > 60 ? 60 : delay * 2 ))
  done
  return 1
}
fetch_pinned /sam/go.tar.gz 9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec \
  https://dl.google.com/go/go1.26.11.linux-amd64.tar.gz https://go.dev/dl/go1.26.11.linux-amd64.tar.gz \
  https://github.com/raphaeltm/simple-agent-manager/releases/download/installer-toolchain-go1.26.11/go1.26.11.linux-amd64.tar.gz
tar -xzf /sam/go.tar.gz -C /usr/local
rm /sam/go.tar.gz
npm install --global --ignore-scripts pnpm@9.15.9
# Pulumi toolchain download is checksum-pinned below.
fetch_pinned /sam/pulumi.tar.gz 58d545f2b98761051922008ebd381ecef95484d7f7a5ff7faa15d7a780ea84f6 \
  https://github.com/pulumi/pulumi/releases/download/v3.272.0/pulumi-v3.272.0-linux-x64.tar.gz \
  https://get.pulumi.com/releases/sdk/pulumi-v3.272.0-linux-x64.tar.gz
mkdir -p /root/.pulumi/bin
tar -xzf /sam/pulumi.tar.gz --strip-components=1 -C /root/.pulumi/bin
rm /sam/pulumi.tar.gz
# crane copies verified prebuilt container images into the account registry
# without Docker (installer-engine-prebuilt.ts); digests survive the copy.
fetch_pinned /sam/crane.tar.gz c14340087103ba9dadf61d45acd20675490fd0ccbd56ac7901fc1b502137f44b \
  https://github.com/google/go-containerregistry/releases/download/v0.20.2/go-containerregistry_Linux_x86_64.tar.gz
tar -xzf /sam/crane.tar.gz -C /usr/local/bin crane
rm /sam/crane.tar.gz
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
