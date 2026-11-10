#!/usr/bin/env bash
# Q5: a node with a valid token for ITSELF must not be able to claim another node's slot.
source "$(dirname "$0")/../scripts/env.sh"
run() { # label nodeId tokenFor proxyName type claimPort claimDomain
  docker rm -f spike-attacker >/dev/null 2>&1
  docker run -d --name spike-attacker -v "$BIN:/opt/spike:ro" -v "$T/node/frpc-attacker.toml:/etc/frpc.toml:ro" \
    -e FRP_SERVER_ADDR="$BOX_ADDR" -e NODE_ID="$2" -e NODE_TOKEN="$( [ "$3" = none ] && echo bogus || token_for "$3")" \
    -e PROXY_NAME="$4" -e PROXY_TYPE="$5" -e CLAIM_PORT="${6:-0}" -e CLAIM_DOMAIN="${7:-x}" \
    alpine:3.22 /opt/spike/frpc -c /etc/frpc.toml >/dev/null
  sleep 3
  echo "## $1"
  docker logs spike-attacker 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'login|start (proxy|error)|reject|error' | sed 's/^/   frpc: /' | head -3
  tail -n 2 "$LOGS/authz.log" | sed 's/^/   authz: /'
}
run "control: node-a, own token, own port 17001 (expect ALLOW)"               node-a node-a node-a-ctl  tcp 17001
run "node-a, own valid token, claims node-b port 17002 (expect REJECT)"     node-a node-a node-a-evil tcp 17002
run "node-a, own valid token, claims node-b domain (expect REJECT)"          node-a node-a node-a-evil http "" node-b.nodes.internal
run "node-a token presented as nodeId=node-b (expect Login REJECT)"          node-b node-a node-b-tcp  tcp 17002
run "proxy name not prefixed with own node id (expect REJECT)"                node-a node-a node-b-tcp  tcp 17001
run "garbage token (expect Login REJECT)"                                     node-a none   node-a-x    tcp 17001
run "own token, port outside frps allowPorts 17000-17999 (expect REJECT)"   node-a node-a node-a-p    tcp 22
echo "## node-b still serves its own slot after the attempts:"; curl -s localhost:8787/tcp/node-b/health; echo
docker rm -f spike-attacker >/dev/null 2>&1
