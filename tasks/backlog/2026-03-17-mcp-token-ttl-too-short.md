# Fix: MCP Token TTL Too Short — Agents Cannot Complete Tasks

## Problem

PR #410 (commit `af303ab`, 2026-03-16) reduced the default MCP token TTL from 2 hours to 30 minutes as a security hardening measure. However, this makes it impossible for agents to call MCP tools (like `complete_task`, `dispatch_task`) after the first 30 minutes of a task's execution.

The token is created once at task start (`task-runner.ts:storeMcpToken()`) and never refreshed. After 30 minutes, the KV entry auto-expires and all subsequent MCP calls fail with 401 Unauthorized.

## Root Cause

- `DEFAULT_MCP_TOKEN_TTL_SECONDS` changed from `7200` (2 hours) to `1800` (30 minutes)
- `MCP_TOKEN_TTL_SECONDS` is not set in production — default is used
- Tasks can run up to 4 hours (`DEFAULT_TASK_RUN_MAX_EXECUTION_MS = 14400000ms`)
- Token TTL vs task execution time: 30 minutes vs 4 hours — massive mismatch

## Research Findings

- `apps/api/src/services/mcp-token.ts:18` — `DEFAULT_MCP_TOKEN_TTL_SECONDS = 1800`
- `apps/api/src/durable-objects/task-runner.ts:848` — `storeMcpToken()` called once at task start, never refreshed
- `apps/api/src/routes/mcp.ts:500` — `authenticateMcpRequest()` validates token via KV (returns null if expired)
- `packages/shared/src/constants.ts:206` — `DEFAULT_TASK_RUN_MAX_EXECUTION_MS = 4 * 60 * 60 * 1000`
- Token is NOT revoked on `complete_task` (by design — see mcp.ts line 831-836 comment)
- KV TTL is the only cleanup mechanism for expired tokens
- `scripts/deploy/` does NOT set `MCP_TOKEN_TTL_SECONDS` — confirmed no override

## Implementation Checklist

- [ ] Increase `DEFAULT_MCP_TOKEN_TTL_SECONDS` to match `DEFAULT_TASK_RUN_MAX_EXECUTION_MS` (4 hours = 14400 seconds)
- [ ] Add `DEFAULT_MCP_TOKEN_TTL_SECONDS` constant to `packages/shared/src/constants.ts` for alignment with other defaults
- [ ] Update comment in `mcp-token.ts` explaining the TTL alignment with task execution time
- [ ] Update `.env.example` comment to reflect new default
- [ ] Update `apps/www` docs configuration reference if it mentions the old default
- [ ] Add/update test verifying TTL default matches task execution max
- [ ] Write regression test: token must remain valid for at least task max execution time

## Acceptance Criteria

- [ ] MCP tokens survive for the full duration of a task (up to 4 hours by default)
- [ ] `DEFAULT_MCP_TOKEN_TTL_SECONDS` is aligned with `DEFAULT_TASK_RUN_MAX_EXECUTION_MS`
- [ ] Existing tests pass
- [ ] New regression test prevents this TTL mismatch from recurring
