#!/usr/bin/env bash
# Harness: build the sample app and `docker compose publish` it to the local OCI
# receiver, then inspect what landed. SPIKE ONLY.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/sample-app"
PORT="${PORT:-5050}"
REGISTRY="localhost:${PORT}"
export SAM_REGISTRY="$REGISTRY"

# Use sudo for docker since the daemon runs as root in this dev container.
DOCKER="sudo -E docker"

echo "=== 0. Sanity: docker reachable ==="
$DOCKER info --format 'driver={{.Driver}}' || { echo "docker not reachable"; exit 1; }

echo "=== 1. Tell docker the registry is insecure (plain HTTP) ==="
# compose publish/push will refuse plain HTTP unless the registry is marked insecure.
# We rely on /etc/docker/daemon.json having insecure-registries set (configured separately).
$DOCKER info 2>/dev/null | grep -A3 "Insecure Registries" || echo "(no insecure registries listed yet)"

echo "=== 2. Build images ==="
( cd "$APP" && $DOCKER compose build ) || { echo "build failed"; exit 1; }

echo "=== 3. compose config (resolved, with image digests would need a push first) ==="
( cd "$APP" && $DOCKER compose config ) | tee "$HERE/_captured/compose-config.resolved.yaml"

echo "=== 4. docker compose publish (full: --app --with-env --resolve-image-digests) ==="
# --app           : bundle referenced images into the artifact
# --with-env      : include env vars in the published OCI artifact
# --resolve-image-digests : pin mutable tags -> immutable @sha256 digests
# --yes           : skip interactive confirmation
( cd "$APP" && $DOCKER compose publish "$REGISTRY/sam-proj/app:v1" \
    --app --with-env --resolve-image-digests --yes 2>&1 ) | tee "$HERE/_captured/publish.stdout.log"
echo "publish exit: ${PIPESTATUS[0]}"

echo "=== 5. Done. Inspect $HERE/_captured ==="
