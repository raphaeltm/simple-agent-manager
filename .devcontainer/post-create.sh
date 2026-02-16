#!/bin/bash
# Post-create setup script for Simple Agent Manager devcontainer
set -e

# Defaults are overridable to avoid hardcoding config.
: "${CLOUDFLARE_OBSERVABILITY_MCP_URL:=https://observability.mcp.cloudflare.com/mcp}"

echo "=== Ensuring agent config dirs exist ==="
mkdir -p "${CODEX_HOME:-$HOME/.codex}"

echo "=== Installing Claude Code (native) ==="
curl -fsSL https://claude.ai/install.sh | bash

echo "=== Installing OpenAI Codex ==="
npm i -g @openai/codex

echo "=== Installing other global tools ==="
npm install -g happy-coder

echo "=== Configuring MCP servers ==="
if ! claude mcp get playwright >/dev/null 2>&1; then
	claude mcp add playwright npx -- @playwright/mcp@latest --browser chromium
fi

# Install Playwright Chromium for ARM64 compatibility (Chrome not supported on ARM64 Linux)
npx playwright install chromium
if ! claude mcp get sequential-thinking >/dev/null 2>&1; then
	claude mcp add sequential-thinking npx -- -y @modelcontextprotocol/server-sequential-thinking
fi
if ! claude mcp get context7 >/dev/null 2>&1; then
	claude mcp add context7 npx -- -y @upstash/context7-mcp
fi

echo "=== Adding Cloudflare Observability MCP (Workers logs) ==="
# Claude Code
if ! claude mcp get cloudflare-observability >/dev/null 2>&1; then
	claude mcp add --transport http cloudflare-observability "$CLOUDFLARE_OBSERVABILITY_MCP_URL"
fi

# Codex
if ! codex mcp get cloudflare-observability >/dev/null 2>&1; then
	codex mcp add cloudflare-observability --url "$CLOUDFLARE_OBSERVABILITY_MCP_URL"
fi

echo "Cloudflare Observability MCP configured (OAuth required per-user)."
echo "If Codex isn't authenticated yet, run:"
echo "  codex mcp login cloudflare-observability"

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
