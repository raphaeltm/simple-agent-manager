#!/usr/bin/env bash
# Exercise the real image install stage and the workspace user's executable path.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
context=$(mktemp -d)
image="sam-codex-runtime-check-$$"
cleanup() { docker image rm "$image" >/dev/null 2>&1 || true; rm -rf -- "$context"; }
trap cleanup EXIT
cp "$repo_root/apps/api/Dockerfile.vm-agent-container" "$context/Dockerfile"
bash "$repo_root/scripts/deploy/prepare-codex-runtime-artifact.sh" "$context/container-artifacts"
docker build --network host --target codex-runtime --tag "$image" "$context"
docker run --rm --user node "$image" bash -ec '
  cd /opt/sam-codex-c2/current
  (cd payload; sha256sum --check SHA256SUMS)
  test "$(bin/codex --version)" = "codex-cli 0.160.0-sam-c2.2"
  test "$(bin/codex-acp --version)" = "@agentclientprotocol/codex-acp 2.1.1-sam-c2.2"
  echo "Pinned runtime image verified as node"
'
