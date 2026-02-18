#!/bin/bash
# test-devcontainer-volume-mount.sh
#
# Replicates the VM agent's devcontainer bootstrap flow in CI:
#   1. Clone the repo to a host directory (simulating the VM's host clone)
#   2. Create a named Docker volume (simulating sam-ws-<workspaceId>)
#   3. Populate the volume from the host clone (via Alpine throwaway container)
#   4. Resolve merged config + inject workspaceMount/workspaceFolder override
#   5. Run devcontainer up with --override-config (full merged config)
#   6. Verify container uses repo's image, not fallback
#   7. Verify lifecycle hooks (postCreateCommand, postStartCommand) executed
#   8. Verify devcontainer features installed (Go, Docker, GitHub CLI)
#
# This catches the exact failure mode where mount overrides accidentally drop
# required config properties (image/dockerFile/dockerComposeFile).
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

# ── Step 4: Resolve merged config + inject mount override ─────────────
# Mirrors VM agent behavior:
#   devcontainer read-configuration --include-merged-configuration
#   inject workspaceMount/workspaceFolder into merged config
#   devcontainer up --override-config <full-merged-override>
echo ""
echo "=== Step 4: Resolve merged config and inject mount override ==="
READ_CONFIG_JSON="/tmp/sam-test-devcontainer-read-config.json"
OVERRIDE_CONFIG="/tmp/sam-test-devcontainer-override.json"

READ_OUTPUT=$(devcontainer read-configuration \
  --workspace-folder "$HOST_CLONE" \
  --include-merged-configuration)
echo "$READ_OUTPUT" > "$READ_CONFIG_JSON"

node -e "
  const fs = require('fs');
  const raw = fs.readFileSync(process.argv[1], 'utf8').trim();
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let payload = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      payload = JSON.parse(lines[i]);
      break;
    } catch {}
  }
  if (!payload) {
    throw new Error('read-configuration output did not contain JSON payload');
  }
  if (payload.outcome !== 'success') {
    throw new Error('read-configuration failed: ' + (payload.message || payload.description || 'unknown error'));
  }
  const merged = payload.mergedConfiguration;
  if (!merged || typeof merged !== 'object') {
    throw new Error('mergedConfiguration missing from read-configuration output');
  }
  const hasRuntimeSource = Boolean(merged.image || merged.dockerFile || merged.dockerComposeFile);
  if (!hasRuntimeSource) {
    throw new Error('mergedConfiguration missing image/dockerFile/dockerComposeFile');
  }
  merged.workspaceMount = 'source=' + process.argv[3] + ',target=/workspaces,type=volume';
  merged.workspaceFolder = '/workspaces/' + process.argv[4];
  fs.writeFileSync(process.argv[2], JSON.stringify(merged, null, 2) + '\n');
  console.log('  OK: merged override config generated');
  console.log('  override path: ' + process.argv[2]);
  console.log('  image: ' + (merged.image || 'N/A'));
  console.log('  dockerFile: ' + (merged.dockerFile || 'N/A'));
  console.log('  dockerComposeFile: ' + (merged.dockerComposeFile || 'N/A'));
  console.log('  features: ' + Object.keys(merged.features || {}).join(', '));
  console.log('  postCreateCommand: ' + (merged.postCreateCommand || 'N/A'));
" "$READ_CONFIG_JSON" "$OVERRIDE_CONFIG" "$VOLUME_NAME" "$REPO_DIR_NAME"

echo "  Final override config:"
cat "$OVERRIDE_CONFIG"

# ── Step 5: Run devcontainer up ───────────────────────────────────────
# Run devcontainer up using the full merged override config.
echo ""
echo "=== Step 5: devcontainer up (with merged override config) ==="
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

echo ""
echo "=== Step 7b: Verify no recovery marker on success ==="
if docker exec "$CONTAINER_ID" test -f /workspaces/.devcontainer-build-error.log; then
  echo "  FAIL: Recovery marker exists despite successful repo devcontainer startup"
  FAIL=$((FAIL + 1))
else
  echo "  OK: No recovery marker found"
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
