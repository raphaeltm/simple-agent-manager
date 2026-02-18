#!/bin/bash
# Post-start script for Simple Agent Manager devcontainer
#
# NOTE: Do NOT use "set -e" here. The devcontainer CLI treats
# postStartCommand failures as hard errors and aborts the entire
# container startup. Optional services like the happy daemon may
# fail in CI or constrained environments — this must not prevent
# the devcontainer from being usable.

echo "=== Start Happy Daemon ==="
if happy daemon start 2>&1; then
  echo "Happy daemon started successfully"
else
  echo "WARNING: Happy daemon failed to start (exit $?). This is non-fatal."
fi