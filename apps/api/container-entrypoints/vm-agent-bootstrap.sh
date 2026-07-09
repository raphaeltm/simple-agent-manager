#!/bin/sh
set -eu

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${VM_AGENT_PORT:=8080}"

mkdir -p /usr/local/bin /var/lib/vm-agent "${WORKSPACE_DIR:-/workspaces/workspace}"

if [ ! -x /usr/local/bin/vm-agent ]; then
  tmp="/usr/local/bin/vm-agent.tmp"
  curl -fsSL "${CONTROL_PLANE_URL}/api/agent/download?os=linux&arch=amd64" -o "$tmp"
  chmod +x "$tmp"
  mv "$tmp" /usr/local/bin/vm-agent
fi

cd /var/lib/vm-agent
exec /usr/local/bin/vm-agent
