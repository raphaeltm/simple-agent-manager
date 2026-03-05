# Fix Prompt Timeout by Session Type

## Problem

Workspace chat sessions time out after 1 hour with "Prompt timed out after 1h0m0s". The current `ACP_PROMPT_TIMEOUT` (default 60m) applies uniformly to all sessions. Workspace chat sessions should have **no timeout limit**, while project/task chat sessions should limit at **6 hours**.

## Research Findings

### Key Files (pre-fix)
- `packages/vm-agent/internal/config/config.go:249` — `ACPPromptTimeout` default was `60*time.Minute`
- `packages/vm-agent/internal/acp/session_host.go:37` — `DefaultPromptTimeout = 60 * time.Minute` (now removed)
- `packages/vm-agent/internal/acp/session_host.go:557-558` — creates `context.WithTimeout(ctx, promptTimeout)`
- `packages/vm-agent/internal/acp/session_host.go:1613-1617` — `promptTimeout()` fell back to `DefaultPromptTimeout` when config is 0
- `packages/vm-agent/internal/acp/session_host.go:1662-1681` — `watchPromptTimeout()` watchdog
- `packages/vm-agent/internal/server/server.go:179` — passes config to gateway
- `packages/vm-agent/internal/acp/gateway.go:145-146` — `PromptTimeout` in `GatewayConfig`

### How Session Type Is Determined
The VM agent config has `TaskID` (set via cloud-init for task-driven workspaces). If `TaskID` is set, it's a project/task session. If empty, it's a direct workspace session.

### Current Behavior (pre-fix)
- `ACPPromptTimeout` defaults to 60 minutes
- `promptTimeout()` returns `DefaultPromptTimeout` (60m) if config value is 0
- `context.WithTimeout()` always applied — no way to disable

## Implementation Checklist

- [x] **config.go**: Add `ACPTaskPromptTimeout` field (default 6h), change `ACPPromptTimeout` default to 0 (disabled)
- [x] **config.go**: Update comment on `ACPPromptTimeout` to reflect "0 = no timeout"
- [x] **session_host.go**: Remove `DefaultPromptTimeout` constant (no longer needed as fallback)
- [x] **session_host.go**: Update `promptTimeout()` to return 0 when config is 0 (meaning no timeout)
- [x] **session_host.go**: Update prompt handler to skip `context.WithTimeout` when timeout is 0, use `context.WithCancel` instead
- [x] **session_host.go**: Update `watchPromptTimeout` to handle 0 timeout (skipped when 0)
- [x] **session_host.go**: Fix misleading "Prompt timed out after 0s" error message for zero-timeout sessions
- [x] **server.go**: Select timeout based on `cfg.TaskID` — use `ACPTaskPromptTimeout` if task-driven, `ACPPromptTimeout` otherwise
- [x] **Update tests**: `prompt_timeout_test.go` for effectivePromptTimeout
- [x] **Update env docs**: `.env.example`, env-reference skill

## Acceptance Criteria

- [x] Workspace chat sessions (no TaskID) have no prompt timeout
- [x] Project/task chat sessions (TaskID set) timeout after 6 hours
- [x] Both timeouts are configurable via env vars
- [x] Existing tests pass
- [x] New tests cover both session types
