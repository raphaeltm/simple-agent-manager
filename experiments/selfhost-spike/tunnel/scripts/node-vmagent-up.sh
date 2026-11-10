#!/usr/bin/env bash
# node-c: the real vm-agent built from packages/vm-agent, in PR #2615's tunnel shape:
# main listener 127.0.0.1:8080 (bearerless Docker git helper), tunnel listener 127.0.0.1:8445
# (requests marked relayed, no loopback trust), frpc dialing the box. No Docker/bash in the
# container, so provisioning steps fail and are skipped; /health and auth still run.
set -euo pipefail
source "$(dirname "$0")/env.sh"
PROTO=${1:-tcp}; SADDR=${2:-$BOX_ADDR}; SPORT=${3:-7000}; CFG=${4:-$T/node/frpc-node-c.toml}
docker rm -f spike-node-c >/dev/null 2>&1 || true
docker run -d --name spike-node-c --add-host box.spike.test:"$BOX_ADDR" \
  -v "$BIN:/opt/spike:ro" -v "$CFG:/etc/frpc.toml:ro" -v "$T/box/tls:/etc/spike-tls:ro" \
  -e NODE_ID=node-c -e CONTROL_PLANE_URL=https://box.spike.test -e VM_AGENT_HOST=127.0.0.1 -e VM_AGENT_PORT=8080 \
  -e VM_AGENT_TUNNEL_ENABLED=true -e VM_AGENT_TUNNEL_PORT=8445 \
  -e PERSISTENCE_DB_PATH=/tmp/state.db -e BOOTSTRAP_STATE_PATH=/tmp/bs.json -e WORKSPACE_BASE_DIR=/tmp/ws -e CALLBACK_TOKEN=dummy \
  -e FRP_SERVER_ADDR="$SADDR" -e FRP_SERVER_PORT="$SPORT" -e FRP_PROTOCOL="$PROTO" -e FRP_CA="${FRP_CA:-}" \
  -e NODE_TOKEN="$(token_for node-c)" -e CLAIM_PORT=17003 -e CLAIM_DOMAIN=node-c.nodes.internal \
  alpine:3.22 sh -c "/opt/spike/vm-agent > /tmp/vm-agent.log 2>&1 & exec /opt/spike/frpc -c /etc/frpc.toml"
