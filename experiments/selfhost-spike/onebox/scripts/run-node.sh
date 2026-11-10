#!/usr/bin/env bash
# Run one real celld node (production mode) in the background.
# usage: run-node.sh <minio|seaweedfs> DATA_DIR LOG [extra celld args]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
. "$HERE/scripts/node-env.sh" "$1"; DATA=$2; LOG=$3; shift 3
mkdir -p "$DATA"
export CELLD_WATCH="$DATA" CELLD_INTERNAL_ADDR=127.0.0.1:7001 CELLD_ADDR=127.0.0.1:8080
nohup "$CELLD" --bucket "$CELLD_BUCKET" "$@" >"$LOG" 2>&1 &
echo $! > "$DATA.pid"; echo "pid $(cat "$DATA.pid")"
