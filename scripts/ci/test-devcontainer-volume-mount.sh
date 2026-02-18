#!/bin/bash
# test-devcontainer-volume-mount.sh
#
# Replicates the VM agent's devcontainer bootstrap flow in CI:
#   1. Clone the repo to a host directory (simulating the VM's host clone)
#   2. Create a named Docker volume (simulating sam-ws-<workspaceId>)
#   3. Populate the volume from the host clone (via Alpine throwaway container)
#   4. Run devcontainer up with --override-config (volume mount override)
#   5. Verify container uses repo's image, not fallback
#   6. Verify lifecycle hooks (postCreateCommand, postStartCommand) executed
#   7. Verify devcontainer features installed (Go, Docker, GitHub CLI)
#
# This catches the exact failure mode where --override-config causes the
# devcontainer CLI to lose the "image" property from the repo's config.
#
# Usage: bash scripts/ci/test-devcontainer-volume-mount.sh [workspace-folder]
#   workspace-folder: path to repo checkout (default: current directory)

set -euo pipefail

WORKSPACE_FOLDER="${1:-.}"
WORKSPACE_FOLDER="$(cd "$WORKSPACE_FOLDER" && pwd)"
REPO_DIR_NAME="$(basename "$WORKSPACE_FOLDER")"

# Simulated host clone path (matches VM agent's /workspace/<repo>)
HOST_CLONE="/tmp/sam-test-host-clone/$REPO_DIR_NAME"

# Named volume (matches VM agent's sam-ws-<workspaceId> pattern)
VOLUME_NAME="sam-test-devcontainer-ci"

# Override config (matches writeMountOverrideConfig in bootstrap.go)
OVERRIDE_CONFIG="/tmp/sam-test-override-config.json"

FAIL=0

# Cleanup function
cleanup() {
  echo ""
  echo "=== Cleanup ==="

  # Stop and remove any devcontainer using our host clone path
  local container_id
  container_id=$(docker ps -aq --filter "label=devcontainer.local_folder=$HOST_CLONE" 2>/dev/null || true)
  if [ -n "$container_id" ]; then
    echo "Removing devcontainer: $container_id"
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi

  # Remove the named volume
  if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    echo "Removing volume: $VOLUME_NAME"
    docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  fi

  # Remove host clone
  if [ -d "$HOST_CLONE" ]; then
    echo "Removing host clone: $HOST_CLONE"
    rm -rf "$HOST_CLONE"
  fi

  # Remove override config
  rm -f "$OVERRIDE_CONFIG"

  echo "Cleanup complete."
}
trap cleanup EXIT

check() {
  local name="$1"
  shift
  if output=$("$@" 2>&1); then
    echo "  OK: $name — $(echo "$output" | head -1)"
  else
    echo "  FAIL: $name (exit $?)"
    echo "    $output" | head -5
    FAIL=$((FAIL + 1))
  fi
}

echo "=============================================="
echo "  SAM Devcontainer Volume Mount Test"
echo "=============================================="
echo ""
echo "Workspace folder: $WORKSPACE_FOLDER"
echo "Repo dir name:    $REPO_DIR_NAME"
echo "Host clone path:  $HOST_CLONE"
echo "Volume name:      $VOLUME_NAME"
echo ""

# ── Step 1: Clone repo to host directory ──────────────────────────────
echo "=== Step 1: Create host clone ==="
mkdir -p "$(dirname "$HOST_CLONE")"
if [ -d "$HOST_CLONE" ]; then
  rm -rf "$HOST_CLONE"
fi
# Use cp instead of git clone since we already have the checkout
cp -a "$WORKSPACE_FOLDER" "$HOST_CLONE"
echo "  Host clone created at $HOST_CLONE"

# Verify the devcontainer config exists on the host
if [ -f "$HOST_CLONE/.devcontainer/devcontainer.json" ]; then
  echo "  OK: .devcontainer/devcontainer.json found on host"
else
  echo "  FAIL: .devcontainer/devcontainer.json NOT found on host"
  exit 1
fi

# Strip JSONC comments from devcontainer.json on the host clone.
# devcontainer CLI v0.83.1 fails to parse JSONC (// comments) when
# --override-config is used, even though it handles JSONC fine without it.
# This matches what the VM agent bootstrap must do before calling devcontainer up.
echo "  Stripping JSONC comments from host clone devcontainer.json..."
DEVCONTAINER_JSON="$HOST_CLONE/.devcontainer/devcontainer.json"
node -e "
  const fs = require('fs');
  const raw = fs.readFileSync(process.argv[1], 'utf8');
  const stripped = raw
    .replace(/\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '\$1');
  const parsed = JSON.parse(stripped);
  fs.writeFileSync(process.argv[1], JSON.stringify(parsed, null, 2) + '\n');
  console.log('  OK: JSONC comments stripped, image=' + parsed.image);
" "$DEVCONTAINER_JSON"

# ── Step 2: Create named Docker volume ────────────────────────────────
echo ""
echo "=== Step 2: Create named Docker volume ==="
docker volume create "$VOLUME_NAME"
echo "  Volume created: $VOLUME_NAME"

# ── Step 3: Populate volume from host clone ───────────────────────────
# This replicates populateVolumeFromHost() in bootstrap.go:
#   docker run --rm -v <host>:/src:ro -v <volume>:/workspaces alpine cp -a /src /workspaces/<repo>
echo ""
echo "=== Step 3: Populate volume from host clone ==="
docker run --rm \
  -v "$HOST_CLONE:/src:ro" \
  -v "$VOLUME_NAME:/workspaces" \
  alpine:latest \
  cp -a /src "/workspaces/$REPO_DIR_NAME"
echo "  Volume populated with repo at /workspaces/$REPO_DIR_NAME"

# Verify the volume has the repo
docker run --rm -v "$VOLUME_NAME:/workspaces" alpine:latest \
  test -d "/workspaces/$REPO_DIR_NAME/.devcontainer"
echo "  OK: .devcontainer/ directory present in volume"

# ── Step 4: Write volume mount override config ────────────────────────
# This replicates writeMountOverrideConfig() in bootstrap.go, but also
# includes the image from the repo's devcontainer.json. devcontainer CLI
# v0.83.1 treats --override-config as a replacement for image/dockerFile/
# dockerComposeFile rather than a merge, so we must include the image.
echo ""
echo "=== Step 4: Write override config ==="

# Extract image from the (already stripped) devcontainer.json
DEVCONTAINER_IMAGE=$(node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  console.log(cfg.image || '');
" "$DEVCONTAINER_JSON")

if [ -n "$DEVCONTAINER_IMAGE" ]; then
  echo "  Detected image from repo config: $DEVCONTAINER_IMAGE"
  cat > "$OVERRIDE_CONFIG" <<EOF
{
  "image": "$DEVCONTAINER_IMAGE",
  "workspaceMount": "source=$VOLUME_NAME,target=/workspaces,type=volume",
  "workspaceFolder": "/workspaces/$REPO_DIR_NAME"
}
EOF
else
  echo "  No image found in repo config, using mount-only override"
  cat > "$OVERRIDE_CONFIG" <<EOF
{
  "workspaceMount": "source=$VOLUME_NAME,target=/workspaces,type=volume",
  "workspaceFolder": "/workspaces/$REPO_DIR_NAME"
}
EOF
fi
echo "  Override config:"
cat "$OVERRIDE_CONFIG"

# ── Step 5: Run devcontainer up with --override-config ────────────────
# This replicates: devcontainer up --workspace-folder <host> --override-config <override>
echo ""
echo "=== Step 5: devcontainer up (with volume mount override) ==="
echo "  Command: devcontainer up --workspace-folder $HOST_CLONE --override-config $OVERRIDE_CONFIG"
echo ""

# Temporarily disable set -e so we can capture the exit code and output
# even when devcontainer up fails (which is the whole point of this test).
UP_LOG="/tmp/sam-test-devcontainer-up.log"
set +e
devcontainer up \
  --workspace-folder "$HOST_CLONE" \
  --override-config "$OVERRIDE_CONFIG" \
  > "$UP_LOG" 2>&1
UP_EXIT=$?
set -e

UP_OUTPUT=$(cat "$UP_LOG")
echo "$UP_OUTPUT"
echo ""

if [ $UP_EXIT -ne 0 ]; then
  echo "FAIL: devcontainer up exited with code $UP_EXIT"
  echo ""
  echo "This is the exact failure mode that causes SAM workspaces to fall"
  echo "back to the default base:ubuntu image, losing all devcontainer features."
  exit 1
fi

echo "  OK: devcontainer up succeeded"

# Extract container ID — devcontainer up outputs JSON on the last line
CONTAINER_ID=$(echo "$UP_OUTPUT" | grep -o '"containerId":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$CONTAINER_ID" ]; then
  # Fallback: try jq on each line
  CONTAINER_ID=$(echo "$UP_OUTPUT" | while IFS= read -r line; do
    echo "$line" | jq -r '.containerId // empty' 2>/dev/null
  done | grep -v '^$' | head -1)
fi
if [ -z "$CONTAINER_ID" ]; then
  echo "  FAIL: Could not extract container ID from output"
  echo "  Raw output:"
  cat "$UP_LOG"
  exit 1
fi
echo "  Container ID: $CONTAINER_ID"

# ── Step 6: Verify correct image (not fallback) ──────────────────────
echo ""
echo "=== Step 6: Verify container image ==="
META_ENV=$(docker exec "$CONTAINER_ID" cat /usr/local/etc/vscode-dev-containers/meta.env 2>/dev/null || echo "")

if echo "$META_ENV" | grep -q "DEFINITION_ID"; then
  DEFINITION_ID=$(echo "$META_ENV" | grep "DEFINITION_ID=" | cut -d= -f2 | tr -d "'\"")
  echo "  DEFINITION_ID: $DEFINITION_ID"

  if [ "$DEFINITION_ID" = "base-ubuntu" ]; then
    echo "  FAIL: Container is running fallback base-ubuntu image!"
    echo "  Expected: typescript-node (from repo's devcontainer.json)"
    echo "  The --override-config caused the devcontainer CLI to lose the 'image' property."
    FAIL=$((FAIL + 1))
  elif echo "$DEFINITION_ID" | grep -qi "typescript-node"; then
    echo "  OK: Container is running the repo's intended image ($DEFINITION_ID)"
  else
    echo "  WARNING: Unexpected DEFINITION_ID: $DEFINITION_ID (not base-ubuntu, not typescript-node)"
  fi
else
  echo "  WARNING: meta.env not found, checking image ancestry..."
  IMAGE_ID=$(docker inspect "$CONTAINER_ID" --format '{{.Config.Image}}' 2>/dev/null || true)
  echo "  Image: $IMAGE_ID"
fi

# ── Step 7: Verify volume mount ───────────────────────────────────────
echo ""
echo "=== Step 7: Verify volume mount ==="
MOUNT_INFO=$(docker inspect "$CONTAINER_ID" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}:{{.Destination}}{{end}}{{end}}' 2>/dev/null || true)
echo "  Volume mounts: $MOUNT_INFO"

if echo "$MOUNT_INFO" | grep -q "$VOLUME_NAME:/workspaces"; then
  echo "  OK: Named volume $VOLUME_NAME mounted at /workspaces"
else
  echo "  FAIL: Named volume not mounted as expected"
  echo "  Full mount info:"
  docker inspect "$CONTAINER_ID" --format '{{json .Mounts}}' | jq .
  FAIL=$((FAIL + 1))
fi

# ── Step 8: Verify devcontainer features ──────────────────────────────
echo ""
echo "=== Step 8: Verify devcontainer features ==="
# These are installed by the features in our devcontainer.json — if the build
# fell back to the default image, these would be missing.
set +e
docker exec "$CONTAINER_ID" bash -c '
  FAIL=0

  check() {
    local name="$1"
    shift
    if output=$("$@" 2>&1); then
      echo "  OK: $name — $(echo "$output" | head -1)"
    else
      echo "  FAIL: $name"
      FAIL=$((FAIL + 1))
    fi
  }

  check "Node.js"    node --version
  check "Go"         go version
  check "Docker"     docker --version
  check "GitHub CLI" gh --version
  check "git"        git --version

  exit $FAIL
'
if [ $? -ne 0 ]; then
  FAIL=$((FAIL + 1))
fi
set -e

# ── Step 9: Verify lifecycle hooks ran ────────────────────────────────
echo ""
echo "=== Step 9: Verify post-create hook artifacts ==="

# Check for node_modules (installed by post-create.sh via pnpm install)
set +e
docker exec "$CONTAINER_ID" bash -c '
  FAIL=0

  if [ -d "/workspaces/'"$REPO_DIR_NAME"'/node_modules" ]; then
    echo "  OK: node_modules exists (pnpm install ran)"
  else
    echo "  FAIL: node_modules missing (pnpm install did not run)"
    FAIL=$((FAIL + 1))
  fi

  # Check for built packages (pnpm build ran)
  for pkg in packages/shared packages/ui packages/terminal packages/acp-client; do
    if [ -d "/workspaces/'"$REPO_DIR_NAME"'/$pkg/dist" ]; then
      echo "  OK: $pkg/dist exists (pnpm build completed)"
    else
      echo "  FAIL: $pkg/dist missing (pnpm build did not complete for $pkg)"
      FAIL=$((FAIL + 1))
    fi
  done

  # Check for Claude Code (installed by post-create.sh)
  if command -v claude >/dev/null 2>&1; then
    echo "  OK: claude command available — $(claude --version 2>&1 | head -1)"
  else
    echo "  FAIL: claude command not found (post-create.sh install failed)"
    FAIL=$((FAIL + 1))
  fi

  exit $FAIL
'
if [ $? -ne 0 ]; then
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Step 10: Verify post-start hook ==="
docker exec "$CONTAINER_ID" bash -c '
  # post-start.sh runs "happy daemon start" — check if happy binary exists
  if command -v happy >/dev/null 2>&1; then
    echo "  OK: happy binary available"
    # Check daemon status (may not be running in CI, which is fine)
    if happy daemon status 2>&1 | grep -qi "running\|started\|active"; then
      echo "  OK: happy daemon is running"
    else
      echo "  INFO: happy daemon not running (non-fatal in CI)"
    fi
  else
    echo "  FAIL: happy binary not found (post-create.sh install failed)"
    exit 1
  fi
'
if [ $? -ne 0 ]; then
  FAIL=$((FAIL + 1))
fi
set -e

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "=============================================="
if [ $FAIL -eq 0 ]; then
  echo "  ALL CHECKS PASSED"
  echo "  Devcontainer volume mount flow works correctly."
else
  echo "  $FAIL CHECK(S) FAILED"
  echo "  The volume mount override is breaking the devcontainer build."
fi
echo "=============================================="

exit $FAIL
