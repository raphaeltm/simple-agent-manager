#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "Claude Code 2.1.258"
  exit 0
fi

echo "mock claude only supports --version" >&2
exit 1
