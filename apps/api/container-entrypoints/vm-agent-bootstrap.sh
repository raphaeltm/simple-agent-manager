#!/bin/sh
set -eu

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${VM_AGENT_PORT:=8080}"

agent_bin="/usr/local/bin/vm-agent"
version_file="/etc/sam/vm-agent-version.json"
bootstrap_started_ms="$(date +%s%3N)"

mkdir -p /var/lib/vm-agent "${WORKSPACE_DIR:-/workspaces/workspace}"

if [ ! -x "${agent_bin}" ] || [ ! -r "${version_file}" ]; then
  echo '{"event":"vm_agent_container_bootstrap_error","reason":"baked_artifact_missing"}' >&2
  exit 1
fi

bootstrap_ready_ms="$(date +%s%3N)"
artifact_json="$(tr -d '\n' < "${version_file}")"
printf '{"event":"vm_agent_container_bootstrap_ready","durationMs":%s,"artifact":%s}\n' \
  "$((bootstrap_ready_ms - bootstrap_started_ms))" "${artifact_json}"
cd /var/lib/vm-agent
exec "${agent_bin}"
