#!/usr/bin/env bash
# Cold build proof only: no account API tokens exist inside this container.
set -euo pipefail
trap 'echo "installer-builder-bootstrap-fit.sh failed at line $LINENO" >&2' ERR
[[ ${SAM_BUILD_FIT_ONLY:-} == 1 && "$PWD" == /sam/source ]]
for name in CF_API_TOKEN CF_RUNTIME_API_TOKEN CLOUDFLARE_API_TOKEN R2_SECRET_ACCESS_KEY; do
  [[ -z ${!name:-} ]] || { echo 'Build-fit proof must have no cloud credentials' >&2; exit 1; }
done
phase() {
  SAM_FIT_PHASE="$1" node --input-type=module - <<'JS'
import {writeFileSync,readFileSync,statfsSync} from 'node:fs';
const disk=statfsSync('/');const state={phase:process.env.SAM_FIT_PHASE,at:Date.now(),diskUsedBytes:(disk.blocks-disk.bfree)*disk.bsize,diskAvailableBytes:disk.bavail*disk.bsize};
try{state.peakMemoryBytes=Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8'));}catch{}
writeFileSync('/sam/job/fit.json',JSON.stringify(state),{mode:0o600});
JS
}
phase codex-runtime
# The same checksum- and size-pinned publisher archive the installation engine stages.
bash scripts/deploy/prepare-codex-runtime-artifact.sh apps/api/container-artifacts
phase application-build
pnpm build
phase cli-build
make -C packages/cli build-all
phase vm-agent-build
make -C packages/vm-agent -o prepare-codex-runtime prepare-container VERSION="$SAM_SOURCE_COMMIT" BUILD_DATE="$(git show -s --format=%cI "$SAM_SOURCE_COMMIT")"
make -C packages/vm-agent build-all VERSION="$SAM_SOURCE_COMMIT" BUILD_DATE="$(git show -s --format=%cI "$SAM_SOURCE_COMMIT")"
phase runtime-image-build
docker build --network=host --load --provenance=false --platform=linux/amd64 -t sam-fit-vm-agent -f apps/api/Dockerfile.vm-agent-container apps/api
phase runtime-image-verify
# This invokes the pinned runtime archive in the production glibc base.
docker run --rm --network=host --entrypoint /opt/sam-codex-c2/current/bin/codex sam-fit-vm-agent --version >/dev/null
phase sandbox-image-build
docker build --network=host --load --provenance=false --platform=linux/amd64 -t sam-fit-sandbox -f apps/api/Dockerfile.sandbox apps/api
phase completed
