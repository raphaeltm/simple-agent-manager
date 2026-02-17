#!/bin/bash
# Post-create setup script for Simple Agent Manager devcontainer
#
# IMPORTANT: Do NOT use "set -e" here. A single tool installation failure
# (network timeout, rate limit, transient error) would abort the entire script,
# causing the devcontainer CLI to report an error and triggering the VM agent's
# fallback to the default base image — losing all devcontainer features (Go,
# Docker-in-Docker, etc.). Each step must be individually fault-tolerant.

FAILURES=0

# Helper: run a command, log failure but continue.
try_run() {
	local label="$1"
	shift
	echo "--- $label ---"
	if ! "$@"; then
		echo "WARNING: $label failed (exit $?), continuing..."
		FAILURES=$((FAILURES + 1))
	fi
}

# Defaults are overridable to avoid hardcoding config.
: "${CLOUDFLARE_OBSERVABILITY_MCP_URL:=https://observability.mcp.cloudflare.com/mcp}"

echo "=== Ensuring agent config dirs exist ==="
mkdir -p "${CODEX_HOME:-$HOME/.codex}"

echo "=== Installing Claude Code (native) ==="
try_run "Install Claude Code" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'

echo "=== Installing OpenAI Codex ==="
try_run "Install OpenAI Codex" npm i -g @openai/codex

echo "=== Installing other global tools ==="
try_run "Install happy-coder" npm install -g happy-coder

echo "=== Configuring MCP servers ==="
if ! claude mcp get playwright >/dev/null 2>&1; then
	try_run "Add Playwright MCP" claude mcp add playwright npx -- @playwright/mcp@latest --browser chromium
fi

# Install Playwright Chromium for ARM64 compatibility (Chrome not supported on ARM64 Linux)
try_run "Install Playwright Chromium" npx playwright install chromium

if ! claude mcp get sequential-thinking >/dev/null 2>&1; then
	try_run "Add sequential-thinking MCP" claude mcp add sequential-thinking npx -- -y @modelcontextprotocol/server-sequential-thinking
fi
if ! claude mcp get context7 >/dev/null 2>&1; then
	try_run "Add context7 MCP" claude mcp add context7 npx -- -y @upstash/context7-mcp
fi

echo "=== Adding Cloudflare Observability MCP (Workers logs) ==="
# Claude Code
if ! claude mcp get cloudflare-observability >/dev/null 2>&1; then
	try_run "Add CF Observability MCP (Claude)" claude mcp add --transport http cloudflare-observability "$CLOUDFLARE_OBSERVABILITY_MCP_URL"
fi

# Codex
if ! codex mcp get cloudflare-observability >/dev/null 2>&1; then
	try_run "Add CF Observability MCP (Codex)" codex mcp add cloudflare-observability --url "$CLOUDFLARE_OBSERVABILITY_MCP_URL"
fi

echo "Cloudflare Observability MCP configured (OAuth required per-user)."
echo "If Codex isn't authenticated yet, run:"
echo "  codex mcp login cloudflare-observability"

echo "=== Setting up Simple Agent Manager development environment ==="

# Install project dependencies — this is critical for the workspace to function.
echo "Installing project dependencies..."
try_run "pnpm install" pnpm install

# Build packages (needed for workspace imports to work)
echo "Building packages..."
try_run "pnpm build" pnpm build

echo ""
if [ "$FAILURES" -gt 0 ]; then
	echo "=== Setup completed with $FAILURES warning(s) ==="
	echo "Some optional tools failed to install. The workspace is functional."
	echo "Re-run this script to retry: bash .devcontainer/post-create.sh"
else
	echo "=== Setup complete! ==="
fi
echo ""
echo "To start development:"
echo "  pnpm run dev:mock    # Start API + Web in mock mode"
echo ""
echo "Ports:"
echo "  8787  - API server"
echo "  5173  - Web UI"
echo "  3001  - CloudCLI (workspace access)"
echo ""
