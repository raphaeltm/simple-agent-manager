#!/bin/sh
set -eu

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${VM_AGENT_PORT:=8080}"

agent_bin_dir="/var/lib/vm-agent/bin"
agent_bin="${agent_bin_dir}/vm-agent"

mkdir -p "${agent_bin_dir}" /var/lib/vm-agent "${WORKSPACE_DIR:-/workspaces/workspace}"

if [ ! -x "${agent_bin}" ]; then
  tmp="${agent_bin}.tmp"
  curl -fsSL "${CONTROL_PLANE_URL}/api/agent/download?os=linux&arch=amd64" -o "$tmp"
  chmod +x "$tmp"
  mv "$tmp" "${agent_bin}"
fi

cd /var/lib/vm-agent
exec "${agent_bin}"
