#!/bin/bash
# Post-create setup script for Simple Agent Manager devcontainer
set -e

echo "=== Installing Claude ==="

npm i -g @anthropic-ai/claude-code @devcontainers/cli
claude mcp add playwright npx -- @playwright/mcp@latest --browser chromium

# Install Playwright Chromium for ARM64 compatibility (Chrome not supported on ARM64 Linux)
npx playwright install chromium
claude mcp add sequential-thinking npx -- -y @modelcontextprotocol/server-sequential-thinking
claude mcp add context7 npx -- -y @upstash/context7-mcp
npm install -g happy-coder


echo "=== Setting up Simple Agent Manager development environment ==="

# Install project dependencies
echo "Installing project dependencies..."
pnpm install

# Build packages (needed for workspace imports to work)
echo "Building packages..."
pnpm build

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To start development:"
echo "  pnpm run dev:mock    # Start API + Web in mock mode"
echo ""
echo "Ports:"
echo "  8787  - API server"
echo "  5173  - Web UI"
echo "  3001  - CloudCLI (workspace access)"
echo ""
