#!/usr/bin/env bash
# Build GNU runtime against the same glibc distribution used by the consumers.
# No deployment/R2 credentials are passed to this inner build container.
set -euo pipefail
[[ $# -eq 2 || $# -eq 3 ]] || exit 2
[[ "$1" == /sam/job/codex-build && "$2" == /sam/job/codex ]] || exit 2
previous=()
[[ $# -lt 3 ]] || { [[ "$3" == /sam/job/previous-codex-trust.json ]]; previous=("$3"); }
docker run --rm --network=host \
  --mount type=bind,source=/sam/source,target=/sam/source \
  --mount type=bind,source=/sam/job,target=/sam/job \
  --mount type=bind,source=/sam/cargo,target=/sam/cargo \
  --mount type=bind,source=/sam/rustup,target=/sam/rustup \
  --env CARGO_HOME=/sam/cargo --env RUSTUP_HOME=/sam/rustup \
  --env PATH=/sam/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --workdir /sam/source \
  docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 \
  bash -c 'set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq --no-install-recommends ca-certificates curl git build-essential pkg-config libssl-dev python3; exec bash scripts/deploy/build-installation-codex-runtime.sh "$@"' \
  sam-source-build "$1" "$2" "${previous[@]}"
