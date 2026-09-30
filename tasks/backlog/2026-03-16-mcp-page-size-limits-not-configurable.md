# MCP Page-Size Limits Not Configurable via Env Vars

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** `messageSearchMax` now reads `MCP_MESSAGE_SEARCH_MAX` (PR #460;
>   `apps/api/src/routes/mcp/_helpers.ts:165`, `apps/api/src/env.ts:1019`). It is not yet
>   documented in `apps/api/.env.example`.
> - **Still open:**
>   - Make `taskListLimit`, `taskListMax`, `taskSearchMax`, `sessionListLimit` and `sessionListMax`
>     configurable; they are still bare constants at `routes/mcp/_helpers.ts:158-162`.
>   - Document those five plus `MCP_MESSAGE_SEARCH_MAX` in `apps/api/.env.example` (only
>     `MCP_MESSAGE_LIST_*` is there, `:736-737`).
>   - The same item also appears at `tasks/backlog/2026-04-13-knowledge-graph-hardening.md:30`;
>     this file owns it.

## Context

Found by constitution-validator during dispatch_task security findings PR review. Eight MCP page-size limits in `getMcpLimits()` use bare constants without env var overrides, violating Principle XI (No Hardcoded Values).

## Problem

In `apps/api/src/routes/mcp.ts`, the `getMcpLimits()` function returns six page-size limits as bare constants:
- `taskListLimit`, `taskListMax`, `taskSearchMax`
- `sessionListLimit`, `sessionListMax`
- `messageSearchMax`

Note: `messageListLimit` and `messageListMax` were resolved in PR #442 (token-message-concatenation).

All other limits in the same function use `parsePositiveInt(env.VAR, DEFAULT)`. These six do not.

## Implementation Checklist

- [x] Add `MCP_MESSAGE_LIST_LIMIT` and `MCP_MESSAGE_LIST_MAX` to `Env` interface (done in PR #442)
- [x] Wire `messageListLimit` and `messageListMax` via `parsePositiveInt()` (done in PR #442)
- [x] Document `MCP_MESSAGE_LIST_LIMIT` and `MCP_MESSAGE_LIST_MAX` in `.env.example` (done in PR #442)
- [ ] Add 6 remaining optional `string?` fields to the `Env` interface in `apps/api/src/index.ts`
- [ ] Replace bare constants in `getMcpLimits()` with `parsePositiveInt(env.MCP_*, DEFAULT_*)` calls for remaining 6 limits
- [ ] Document the 6 remaining vars in `apps/api/.env.example`

## Acceptance Criteria

- [x] `messageListLimit` and `messageListMax` configurable (PR #442)
- [ ] All 6 remaining page-size limits are configurable via environment variables
- [ ] Default behavior is unchanged (same default values)
- [ ] Existing tests pass
