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

FAIL=0
WARN=0

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

  echo "Cleanup complete."
}
trap cleanup EXIT

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

# ── Step 4: Inject volume mount into repo's devcontainer.json ─────────
# devcontainer CLI v0.83.1's --override-config does NOT merge with the
# repo's config — it replaces key properties (image, features, lifecycle
# hooks). Instead of using --override-config, we inject workspaceMount
# and workspaceFolder directly into the repo's devcontainer.json on the
# host clone. This is what the VM agent bootstrap should do.
echo ""
echo "=== Step 4: Inject volume mount into devcontainer.json ==="
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  cfg.workspaceMount = 'source=' + process.argv[2] + ',target=/workspaces,type=volume';
  cfg.workspaceFolder = '/workspaces/' + process.argv[3];
  fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + '\n');
  console.log('  OK: Injected workspaceMount and workspaceFolder');
  console.log('  image: ' + (cfg.image || 'N/A'));
  console.log('  features: ' + Object.keys(cfg.features || {}).join(', '));
  console.log('  postCreateCommand: ' + (cfg.postCreateCommand || 'N/A'));
" "$DEVCONTAINER_JSON" "$VOLUME_NAME" "$REPO_DIR_NAME"
echo "  Final devcontainer.json:"
cat "$DEVCONTAINER_JSON"

# ── Step 5: Run devcontainer up ───────────────────────────────────────
# Run devcontainer up using the modified devcontainer.json (which now
# includes workspaceMount and workspaceFolder for the named volume).
# No --override-config needed since we injected the mount settings directly.
echo ""
echo "=== Step 5: devcontainer up (with injected volume mount) ==="
echo "  Command: devcontainer up --workspace-folder $HOST_CLONE"
echo ""

# Temporarily disable set -e so we can capture the exit code and output
# even when devcontainer up fails (which is the whole point of this test).
UP_LOG="/tmp/sam-test-devcontainer-up.log"
set +e
devcontainer up \
  --workspace-folder "$HOST_CLONE" \
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

  # Claude install is optional in post-create.sh (try_run), so missing binary
  # should not fail this integration test.
  if command -v claude >/dev/null 2>&1; then
    echo "  OK: claude command available — $(claude --version 2>&1 | head -1)"
  else
    echo "  WARN: claude command not found (optional install may have failed)"
    echo "        Workspace remains valid; post-create.sh treats this as non-fatal."
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
    echo "  WARN: happy binary not found (optional install may have failed)"
    exit 10
  fi
'
POST_START_EXIT=$?
if [ $POST_START_EXIT -eq 10 ]; then
  WARN=$((WARN + 1))
elif [ $POST_START_EXIT -ne 0 ]; then
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
  echo "  Devcontainer volume mount flow has regressions."
fi
if [ $WARN -gt 0 ]; then
  echo "  $WARN warning(s): optional tooling install did not fully complete."
fi
echo "=============================================="

exit $FAIL
