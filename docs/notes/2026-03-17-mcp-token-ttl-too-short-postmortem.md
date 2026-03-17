# Post-Mortem: MCP Token TTL Too Short (30 min vs 4 hour tasks)

**Date**: 2026-03-17
**Severity**: High — all agent MCP tool calls fail after 30 minutes
**Duration**: ~1 day (introduced 2026-03-16, fixed 2026-03-17)

## What Broke

Agents could not call `complete_task`, `dispatch_task`, or any other MCP tool after ~30 minutes of task execution. The MCP token stored in Cloudflare KV auto-expired, causing 401 Unauthorized responses for all subsequent tool calls.

## Root Cause

PR #410 (commit `af303ab`, 2026-03-16) reduced `DEFAULT_MCP_TOKEN_TTL_SECONDS` from 7200 (2 hours) to 1800 (30 minutes) as part of security hardening. However, the MCP token is created once at task start (`task-runner.ts:storeMcpToken()`) and never refreshed. Tasks can run up to 4 hours (`DEFAULT_TASK_RUN_MAX_EXECUTION_MS = 14400000ms`). After 30 minutes, the KV entry auto-expires and all MCP tool calls fail.

## Timeline

- **2026-03-16**: PR #410 merged, reducing TTL from 2h to 30min
- **2026-03-17**: Bug reported — agents can't call `complete_task`/`dispatch_task`
- **2026-03-17**: Root cause identified, fix implemented and deployed

## Why It Wasn't Caught

1. **No regression guard test** — no test asserted that the MCP token TTL must be >= the task max execution time
2. **No cross-constant validation** — the TTL constant was local to `mcp-token.ts` with no link to `DEFAULT_TASK_RUN_MAX_EXECUTION_MS` in `shared/constants.ts`
3. **Manual review missed the dependency** — the reviewer saw "reduce TTL for security" without checking what the token lifetime needs to cover

## Class of Bug

**Cross-constant invariant violation** — two independently configurable values (`MCP_TOKEN_TTL_SECONDS` and `DEFAULT_TASK_RUN_MAX_EXECUTION_MS`) have an implicit ordering constraint (TTL >= execution time) that was not enforced by code or tests.

## Process Fix

1. **Regression guard test added** (`mcp-token.test.ts`): asserts `DEFAULT_MCP_TOKEN_TTL_SECONDS >= DEFAULT_TASK_RUN_MAX_EXECUTION_MS / 1000` — this test would have caught PR #410's reduction
2. **Constant moved to shared** (`packages/shared/src/constants.ts`): places the TTL constant next to the task execution time constant, making the relationship visible
3. **Behavioral test added**: verifies that `storeMcpToken()` actually passes a TTL >= task max execution seconds to KV
