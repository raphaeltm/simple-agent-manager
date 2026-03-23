# Prevent ACP Session Timeouts on Resource-Constrained Nodes

## Problem

Intermittent "context deadline exceeded" errors occur during ACP session creation when nodes are overloaded with too many workspaces. Two root causes:

1. **No hard workspace count limit**: Nodes can accumulate unlimited workspaces if CPU/memory metrics are stale or unreported, leading to resource exhaustion.
2. **Shared timeout budget**: `session_host.go:startAgent()` creates a single 30s context (`initCtx`) shared across Initialize, LoadSession, and NewSession RPCs. On slow nodes, Initialize consumes most of the budget and NewSession times out.

## Research Findings

### Change 1: Hard workspace count limit per node

**Key files:**
- `packages/shared/src/constants.ts` — other `DEFAULT_*` constants live here (line 98+)
- `apps/api/src/services/node-selector.ts` — `selectNodeForTaskRun()` computes `activeCount` at line 223, calls `nodeHasCapacity()` at line 236. `NodeSelectorEnv` interface at line 26 needs the new env var.
- `apps/api/src/durable-objects/task-runner.ts` — `findNodeWithCapacity()` at line 1342 has a parallel implementation that also needs the workspace count check. Comment at line 1373 says "not by a hard workspace count limit" — this needs updating.
- `apps/api/src/index.ts` — `Env` interface needs `MAX_WORKSPACES_PER_NODE?: string` (near line 106 with other hierarchy limits)
- `apps/api/.env.example` — document the new env var

**Both** `selectNodeForTaskRun()` and `findNodeWithCapacity()` in the TaskRunner DO need the limit applied. The TaskRunner uses raw SQL and doesn't call `nodeHasCapacity()`, so it needs its own workspace count query.

### Change 2: Separate timeouts per ACP phase

**Key files:**
- `packages/vm-agent/internal/acp/session_host.go` — `startAgent()` at line 951-957 creates single `initCtx`. Initialize at line 963, LoadSession at line 996, NewSession at line 1034 all share `initCtx`.
- `packages/vm-agent/internal/acp/gateway.go` — `GatewayConfig` at line 95 has `InitTimeoutMs` field
- `packages/vm-agent/internal/config/config.go` — `ACPInitTimeoutMs` at line 95, loaded from `ACP_INIT_TIMEOUT_MS` env var at line 261

**Approach:** Add `ACPInitializeTimeoutMs`, `ACPNewSessionTimeoutMs`, `ACPLoadSessionTimeoutMs` to config. Add corresponding fields to `GatewayConfig`. In `startAgent()`, create separate timeout contexts for each phase, falling back to `InitTimeoutMs` if per-phase values aren't set.

## Implementation Checklist

### Change 1: Hard workspace count limit

- [ ] Add `DEFAULT_MAX_WORKSPACES_PER_NODE = 3` to `packages/shared/src/constants.ts`
- [ ] Add `MAX_WORKSPACES_PER_NODE?: string` to `NodeSelectorEnv` in `apps/api/src/services/node-selector.ts`
- [ ] Add workspace count check in `selectNodeForTaskRun()` after computing `activeCount` (line 223) — reject if `activeCount >= maxWorkspacesPerNode`
- [ ] Update `nodeHasCapacity()` signature or add separate function to include workspace count limit
- [ ] Add `MAX_WORKSPACES_PER_NODE?: string` to `Env` interface in `apps/api/src/index.ts`
- [ ] Add workspace count check in `findNodeWithCapacity()` in `apps/api/src/durable-objects/task-runner.ts`
- [ ] Document `MAX_WORKSPACES_PER_NODE` in `apps/api/.env.example`
- [ ] Update unit tests in `apps/api/tests/unit/node-selector-flow.test.ts`
- [ ] Update integration tests in `apps/api/tests/integration/node-selection.test.ts`

### Change 2: Separate ACP phase timeouts

- [ ] Add `ACPInitializeTimeoutMs`, `ACPNewSessionTimeoutMs`, `ACPLoadSessionTimeoutMs` to `Config` in `packages/vm-agent/internal/config/config.go`
- [ ] Load from `ACP_INITIALIZE_TIMEOUT_MS` (default 30000), `ACP_NEW_SESSION_TIMEOUT_MS` (default 30000), `ACP_LOAD_SESSION_TIMEOUT_MS` (default 15000) env vars
- [ ] Add `InitializeTimeoutMs`, `NewSessionTimeoutMs`, `LoadSessionTimeoutMs` to `GatewayConfig` in `packages/vm-agent/internal/acp/gateway.go`
- [ ] Wire new config fields where GatewayConfig is constructed (in `server.go` or similar)
- [ ] Refactor `startAgent()` in `session_host.go` to use separate timeout contexts per phase
- [ ] Keep backward compatibility: if per-phase values are 0, fall back to `InitTimeoutMs`
- [ ] Document new env vars in `apps/api/.env.example`
- [ ] Add unit tests for config loading with new timeout fields
- [ ] Add unit test verifying separate timeout contexts in session_host

## Acceptance Criteria

- [ ] Nodes with `>= MAX_WORKSPACES_PER_NODE` active workspaces are rejected by both `selectNodeForTaskRun()` and `findNodeWithCapacity()`
- [ ] Default limit is 3 workspaces per node, configurable via env var
- [ ] Each ACP phase (Initialize, LoadSession, NewSession) has its own independent timeout
- [ ] Existing `ACP_INIT_TIMEOUT_MS` works as fallback when per-phase vars aren't set
- [ ] All new values are configurable via environment variables (constitution Principle XI)
- [ ] Tests prove workspace count limit works even when CPU/memory metrics show capacity
- [ ] Tests prove per-phase timeout config is loaded correctly

## References

- `apps/api/src/services/node-selector.ts`
- `apps/api/src/durable-objects/task-runner.ts` (lines 1342-1417)
- `packages/vm-agent/internal/acp/session_host.go` (lines 920-1055)
- `packages/vm-agent/internal/config/config.go`
- `packages/vm-agent/internal/acp/gateway.go` (lines 95-115)
- `packages/shared/src/constants.ts`
