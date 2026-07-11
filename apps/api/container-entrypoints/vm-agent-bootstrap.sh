#!/bin/sh
set -eu

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${VM_AGENT_PORT:=8080}"

# Paths default to the baked image locations; overridable so the fail-fast
# behavior can be exercised by tests without the production filesystem layout.
agent_bin="${VM_AGENT_BIN:-/usr/local/bin/vm-agent}"
version_file="${VM_AGENT_VERSION_FILE:-/etc/sam/vm-agent-version.json}"
state_dir="${VM_AGENT_STATE_DIR:-/var/lib/vm-agent}"
bootstrap_started_ms="$(date +%s%3N)"

mkdir -p "${state_dir}" "${WORKSPACE_DIR:-/workspaces/workspace}"

if [ ! -x "${agent_bin}" ] || [ ! -r "${version_file}" ]; then
  echo '{"event":"vm_agent_container_bootstrap_error","reason":"baked_artifact_missing"}' >&2
  exit 1
fi

bootstrap_ready_ms="$(date +%s%3N)"
artifact_json="$(tr -d '\n' < "${version_file}")"
printf '{"event":"vm_agent_container_bootstrap_ready","durationMs":%s,"artifact":%s}\n' \
  "$((bootstrap_ready_ms - bootstrap_started_ms))" "${artifact_json}"
cd "${state_dir}"
exec "${agent_bin}"
