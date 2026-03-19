# Wrap MCP notification blocks in waitUntil()

## Problem

MCP notification blocks in `apps/api/src/routes/mcp.ts` await D1 queries (`getProjectName`, `getChatSessionId`) synchronously in the response path. This adds 1-2 D1 round-trips to every `update_task_status` MCP response, stalling the agent.

## Context

Discovered during cloudflare-specialist review of PR fixing notification panel links. The `crud.ts` notification blocks already use `waitUntil()` correctly. The MCP handlers don't have access to `c.executionCtx` — it would need to be threaded through as a parameter.

## Implementation

1. Pass `c.executionCtx` to `handleUpdateTaskStatus`, `handleCompleteTask`, `handleRequestHumanInput`
2. Wrap each `if (env.NOTIFICATION)` block in `ctx.waitUntil()`
3. Move the try/catch inside the promise, add `.catch()` on the waitUntil promise

## Acceptance Criteria

- [ ] All 4 MCP notification blocks use `waitUntil()` instead of synchronous await
- [ ] MCP responses return immediately without waiting for notification delivery
- [ ] Existing notification tests still pass
