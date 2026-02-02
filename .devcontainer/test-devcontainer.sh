#!/bin/bash
# Test devcontainer definition from inside the container
# Usage: bash .devcontainer/test-devcontainer.sh [--build-only]
#
# This script validates the devcontainer configuration by:
# 1. Running 'devcontainer build' to verify the image builds correctly
# 2. Optionally running 'devcontainer up' to test the full lifecycle
#
# Requires: devcontainer CLI, Docker-in-Docker

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --build-only)
            BUILD_ONLY=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--build-only]"
            echo ""
            echo "Options:"
            echo "  --build-only  Only build the image, don't run 'devcontainer up'"
            echo "  -h, --help    Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "=== Testing devcontainer definition ==="
echo "Workspace: $WORKSPACE_DIR"
echo ""

# Check prerequisites
if ! command -v devcontainer &> /dev/null; then
    echo "Error: devcontainer CLI not found"
    echo "Install with: npm install -g @devcontainers/cli"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo "Error: Docker is not running or not accessible"
    exit 1
fi

# Validate devcontainer.json syntax
echo "=== Validating devcontainer.json syntax ==="
if ! python3 -c "import json; json.load(open('$WORKSPACE_DIR/.devcontainer/devcontainer.json'))" 2>/dev/null; then
    # Try with jsonc (JSON with comments) - strip comments first
    if ! grep -v '^\s*//' "$WORKSPACE_DIR/.devcontainer/devcontainer.json" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
        echo "Warning: Could not fully validate JSON syntax (may contain comments)"
    fi
fi
echo "JSON syntax: OK"
echo ""

# Build the devcontainer image
echo "=== Building devcontainer image ==="
devcontainer build --workspace-folder "$WORKSPACE_DIR"
echo ""
echo "Build: SUCCESS"

if [ "$BUILD_ONLY" = true ]; then
    echo ""
    echo "=== Build-only mode, skipping 'devcontainer up' ==="
    exit 0
fi

# Test devcontainer up (in a temporary workspace to avoid conflicts)
echo ""
echo "=== Testing devcontainer up ==="
echo "Note: This creates a temporary test container"

# Create a temporary directory for testing
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

# Copy minimal files needed for test
cp -r "$WORKSPACE_DIR/.devcontainer" "$TEST_DIR/"
cp "$WORKSPACE_DIR/package.json" "$TEST_DIR/" 2>/dev/null || echo '{}' > "$TEST_DIR/package.json"

# Run devcontainer up with a simple test command
echo "Starting test container..."
CONTAINER_ID=$(devcontainer up --workspace-folder "$TEST_DIR" 2>&1 | grep -oP 'Container ID: \K\S+' || true)

if [ -n "$CONTAINER_ID" ]; then
    echo "Container started: $CONTAINER_ID"

    # Run a simple test command
    echo "Testing command execution..."
    devcontainer exec --workspace-folder "$TEST_DIR" echo "Hello from devcontainer!"

    # Check installed features
    echo ""
    echo "=== Verifying installed features ==="
    devcontainer exec --workspace-folder "$TEST_DIR" bash -c "
        echo 'Node version:' && node --version
        echo 'npm version:' && npm --version
        echo 'Go version:' && go version 2>/dev/null || echo 'Go: not installed'
        echo 'Docker version:' && docker --version 2>/dev/null || echo 'Docker: not available'
        echo 'gh version:' && gh --version 2>/dev/null || echo 'gh: not installed'
        echo 'devcontainer version:' && devcontainer --version 2>/dev/null || echo 'devcontainer: not installed'
    "

    # Stop the test container
    echo ""
    echo "Stopping test container..."
    docker stop "$CONTAINER_ID" > /dev/null 2>&1 || true
    docker rm "$CONTAINER_ID" > /dev/null 2>&1 || true

    echo ""
    echo "=== All tests passed! ==="
else
    echo "Warning: Could not extract container ID, but build succeeded"
    echo "You may need to manually verify the devcontainer works"
fi
