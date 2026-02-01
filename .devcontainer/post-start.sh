#!/bin/bash
# Post-create setup script for Simple Agent Manager devcontainer
set -e

echo "=== Create Claude Home ==="
mkdir -p /workspaces/claude-home

echo "=== Start Happy Daemon ==="
happy daemon start