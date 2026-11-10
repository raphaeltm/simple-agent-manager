#!/usr/bin/env bash
# Starts a "node" container: backend on container loopback :8444 + frpc dialing the box.
# No published ports; nothing listens on the container's external interface.
# Usage: node-up.sh NODE_ID [CLAIM_PORT] [CLAIM_DOMAIN] [TOKEN_FOR] [PROTOCOL] [SERVER_ADDR] [SERVER_PORT] [FRPC_CONFIG]
set -euo pipefail
source "$(dirname "$0")/env.sh"
NODE=$1; DEFAULT_PORT=$([ "$NODE" = node-a ] && echo 17001 || echo 17002)
CLAIM_PORT=${2:-$DEFAULT_PORT}; CLAIM_DOMAIN=${3:-$NODE.nodes.internal}; TOKEN_NODE=${4:-$NODE}
PROTO=${5:-tcp}; SADDR=${6:-$BOX_ADDR}; SPORT=${7:-7000}; CFG=${8:-$T/node/frpc-$NODE.toml}
docker rm -f "spike-$NODE" >/dev/null 2>&1 || true
docker run -d --name "spike-$NODE" --add-host box.spike.test:"$BOX_ADDR" \
  -v "$BIN:/opt/spike:ro" -v "$CFG:/etc/frpc.toml:ro" -v "$T/box/tls:/etc/spike-tls:ro" \
  -e FRP_SERVER_ADDR="$SADDR" -e FRP_SERVER_PORT="$SPORT" -e FRP_PROTOCOL="$PROTO" \
  -e FRP_CA="${FRP_CA:-}" -e NODE_TOKEN="$(token_for "$TOKEN_NODE")" -e CLAIM_PORT="$CLAIM_PORT" -e CLAIM_DOMAIN="$CLAIM_DOMAIN" \
  alpine:3.22 sh -c "/opt/spike/echo-backend -node $NODE -listen 127.0.0.1:8444 & while true; do /opt/spike/frpc -c /etc/frpc.toml; echo \"frpc exited \$?, restarting in 1s (like systemd Restart=always RestartSec=1)\"; sleep 1; done"
