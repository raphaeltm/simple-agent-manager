#!/usr/bin/env bash
# The VM agent embeds this same reviewed installer; keep one source of truth.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
exec bash "$script_dir/../../packages/vm-agent/internal/acp/codex_runtime_installer.sh" "$@"
