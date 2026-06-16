#!/usr/bin/env bash
# Prepare local image tags for devcontainer CI tests.
#
# GitHub-hosted runners can hit Microsoft Container Registry anonymous limits.
# The VM-agent/devcontainer tests only need stable Debian/Ubuntu/Node/Python
# devcontainer-like images, so CI builds local fixtures and tags them with the
# MCR names used by repo fixtures. Docker then satisfies devcontainer CLI image
# inspection from the local daemon instead of pulling from MCR.

set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PNPM_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' package.json | head -1)"

if [[ -z "$PNPM_VERSION" ]]; then
  echo "Could not determine pnpm version from package.json" >&2
  exit 1
fi

retry() {
  local attempts=4
  local delay=5
  local attempt=1

  while true; do
    if "$@"; then
      return 0
    fi

    if [[ "$attempt" -ge "$attempts" ]]; then
      echo "Command failed after $attempt attempts: $*" >&2
      return 1
    fi

    echo "Command failed, retrying in ${delay}s ($attempt/$attempts): $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

write_dockerfile() {
  local base_image="$1"
  local dockerfile="$2"

  cat > "$dockerfile" <<EOF
FROM ${base_image}

ARG PNPM_VERSION

RUN set -eux; \\
    mkdir -p /workspaces /usr/local/etc/vscode-dev-containers; \\
    if ! id -u vscode >/dev/null 2>&1; then \\
      if ! getent group vscode >/dev/null 2>&1; then \\
        groupadd vscode; \\
      fi; \\
      if getent passwd 1001 >/dev/null 2>&1; then \\
        useradd -m -g vscode -s /bin/bash vscode; \\
      else \\
        useradd -m -u 1001 -g vscode -s /bin/bash vscode; \\
      fi; \\
    fi; \\
    if command -v npm >/dev/null 2>&1 && ! command -v pnpm >/dev/null 2>&1; then \\
      npm install -g "pnpm@\${PNPM_VERSION}"; \\
    fi; \\
    chown vscode:vscode /workspaces

CMD ["sleep", "infinity"]
EOF
}

prepare_fixture_image() {
  local target_image="$1"
  local base_image="$2"
  local context_dir="$TMP_DIR/${target_image//[^A-Za-z0-9_.-]/_}"

  if docker image inspect "$target_image" >/dev/null 2>&1; then
    echo "Fixture image already present: $target_image"
    return 0
  fi

  echo "Preparing fixture image: $target_image from $base_image"
  retry docker pull "$base_image"

  mkdir -p "$context_dir"
  write_dockerfile "$base_image" "$context_dir/Dockerfile"
  retry docker build --pull=false --build-arg "PNPM_VERSION=$PNPM_VERSION" -t "$target_image" "$context_dir"
}

prepull_image() {
  local image="$1"

  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "Image already present: $image"
    return 0
  fi

  echo "Pulling test image: $image"
  retry docker pull "$image"
}

prepare_fixture_image "mcr.microsoft.com/devcontainers/base:debian" "buildpack-deps:bookworm"
prepare_fixture_image "mcr.microsoft.com/devcontainers/base:ubuntu" "buildpack-deps:jammy"
prepare_fixture_image "mcr.microsoft.com/devcontainers/typescript-node:22-bookworm" "node:22-bookworm"
prepare_fixture_image "mcr.microsoft.com/devcontainers/typescript-node:24-bookworm" "node:24-bookworm"
prepare_fixture_image "mcr.microsoft.com/devcontainers/python:3.12" "python:3.12-bookworm"

# Directly referenced by integration helpers and the volume-copy test.
prepull_image "alpine:latest"
prepull_image "debian:bookworm-slim"
prepull_image "node:22-bookworm"

echo "Devcontainer fixture images are ready."
