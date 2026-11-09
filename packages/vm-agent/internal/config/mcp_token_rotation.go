package config

import "time"

// SAM MCP token rotation after a workspace callback generation rotation. When a
// restart or rebuild delivers a new workspace callback token, the agent swaps
// each session's sam-mcp token through
// POST /api/workspaces/:id/mcp-token/rotate before provisioning continues.
//
// Worst case at the defaults: one entry takes 3 attempts x 10s + 1s + 2s of
// backoff = 33s; the whole pass is cut off at the 60s budget, so a restart
// waits at most about one minute for rotation however many sessions exist. At a
// normal control-plane latency (well under 1s per request) the budget covers
// hundreds of sessions; a typical workspace has a handful.
const (
	// DefaultMcpTokenRotationTimeout bounds one rotation request.
	// Override via MCP_TOKEN_ROTATION_TIMEOUT.
	DefaultMcpTokenRotationTimeout = 10 * time.Second
	// DefaultMcpTokenRotationMaxAttempts bounds attempts per sam-mcp entry for
	// transient failures (5xx, 429, network). Override via MCP_TOKEN_ROTATION_MAX_ATTEMPTS.
	DefaultMcpTokenRotationMaxAttempts = 3
	// MaxMcpTokenRotationMaxAttempts caps the configured attempt count.
	MaxMcpTokenRotationMaxAttempts = 10
	// DefaultMcpTokenRotationRetryDelay is the first backoff between attempts;
	// it doubles per attempt. Override via MCP_TOKEN_ROTATION_RETRY_DELAY.
	DefaultMcpTokenRotationRetryDelay = time.Second
	// DefaultMcpTokenRotationBudget bounds the whole rotation pass, which runs
	// before provisioning. Override via MCP_TOKEN_ROTATION_BUDGET.
	DefaultMcpTokenRotationBudget = time.Minute
)
