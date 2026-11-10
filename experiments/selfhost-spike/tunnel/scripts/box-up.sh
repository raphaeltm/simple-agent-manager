#!/usr/bin/env bash
# Starts the "box": authz plugin endpoint, frps, celld dev (test Worker). Restarts any previous ones.
set -euo pipefail
source "$(dirname "$0")/env.sh"
"$(dirname "$0")/box-down.sh"
nohup node "$T/box/authz/server.mjs" > "$LOGS/authz.log" 2>&1 & echo $! > "$LOGS/authz.pid"
nohup frps -c "${FRPS_CONFIG:-$T/box/frps.toml}" > "$LOGS/frps.log" 2>&1 & echo $! > "$LOGS/frps.pid"
( cd "$T" && nohup celld dev worker --port 8787 > "$LOGS/celld.log" 2>&1 & echo $! > "$LOGS/celld.pid" )
for i in $(seq 1 40); do curl -sf localhost:8787/ >/dev/null && break; sleep 0.25; done
curl -s localhost:8787/
