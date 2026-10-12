# Wrap MCP notification blocks in waitUntil()

> **Reconciliation 2026-10-12:** Scope unchanged: all three blocks still `await` the notification
> round-trip. Pointers moved: #2293 (`6973ceb77`) and #2307 (`b5f866a90`) cut
> `apps/api/src/routes/mcp/task-tools.ts` to 454 lines; the blocks are now `:126-153`
> (`update_task_status`), `:253-272` (conversation-mode `complete_task`) and `:377-398` (task-mode
> `complete_task`). `request_human_input` moved to `routes/mcp/human-input-tool.ts` (#2213). The
> context is already passed to `handleCompleteTask` (`routes/mcp/index.ts:309-315`) but ignored
> (`_executionCtx`, `task-tools.ts:171`); `handleUpdateTaskStatus` gets none (`index.ts:300`).

> **Reconciliation 2026-09-30:** still open. Scope is now the 3 blocks in `task-tools.ts`
> (`:244-270`, `:389-409`, `:531-553`); `request_human_input` must stay synchronous (its reply uses
> the notification id). `apps/api/src/routes/mcp.ts` is now `apps/api/src/routes/mcp/task-tools.ts`.

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
