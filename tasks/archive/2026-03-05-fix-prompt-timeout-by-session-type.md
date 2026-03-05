# Fix Prompt Timeout by Session Type

## Problem

Workspace chat sessions time out after 1 hour with "Prompt timed out after 1h0m0s". The current `ACP_PROMPT_TIMEOUT` (default 60m) applies uniformly to all sessions. Workspace chat sessions should have **no timeout limit**, while project/task chat sessions should limit at **6 hours**.

## Research Findings

### Key Files
- `packages/vm-agent/internal/config/config.go:249` — `ACPPromptTimeout` default is `60*time.Minute`
- `packages/vm-agent/internal/acp/session_host.go:37` — `DefaultPromptTimeout = 60 * time.Minute`
- `packages/vm-agent/internal/acp/session_host.go:557-558` — creates `context.WithTimeout(ctx, promptTimeout)`
- `packages/vm-agent/internal/acp/session_host.go:1613-1617` — `promptTimeout()` falls back to `DefaultPromptTimeout` when config is 0
- `packages/vm-agent/internal/acp/session_host.go:1662-1681` — `watchPromptTimeout()` watchdog
- `packages/vm-agent/internal/server/server.go:179` — passes config to gateway
- `packages/vm-agent/internal/acp/gateway.go:145-146` — `PromptTimeout` in `GatewayConfig`

### How Session Type Is Determined
The VM agent config has `TaskID` (set via cloud-init for task-driven workspaces). If `TaskID` is set, it's a project/task session. If empty, it's a direct workspace session.

### Current Behavior
- `ACPPromptTimeout` defaults to 60 minutes
- `promptTimeout()` returns `DefaultPromptTimeout` (60m) if config value is 0
- `context.WithTimeout()` always applied — no way to disable

## Implementation Checklist

- [ ] **config.go**: Add `ACPTaskPromptTimeout` field (default 6h), change `ACPPromptTimeout` default to 0 (disabled)
- [ ] **config.go**: Update comment on `ACPPromptTimeout` to reflect "0 = no timeout"
- [ ] **session_host.go**: Remove `DefaultPromptTimeout` constant (no longer needed as fallback)
- [ ] **session_host.go**: Update `promptTimeout()` to return 0 when config is 0 (meaning no timeout)
- [ ] **session_host.go**: Update prompt handler (~line 557) to skip `context.WithTimeout` when timeout is 0, use parent context directly
- [ ] **session_host.go**: Update `watchPromptTimeout` to handle 0 timeout (no-op/skip)
- [ ] **server.go**: Select timeout based on `cfg.TaskID` — use `ACPTaskPromptTimeout` if task-driven, `ACPPromptTimeout` otherwise
- [ ] **Update tests**: config test, session_host timeout tests
- [ ] **Update env docs**: `.env.example`, env-reference skill

## Acceptance Criteria

- [ ] Workspace chat sessions (no TaskID) have no prompt timeout
- [ ] Project/task chat sessions (TaskID set) timeout after 6 hours
- [ ] Both timeouts are configurable via env vars
- [ ] Existing tests pass
- [ ] New tests cover both session types
