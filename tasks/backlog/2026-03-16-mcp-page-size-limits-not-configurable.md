# MCP Page-Size Limits Not Configurable via Env Vars

## Context

Found by constitution-validator during dispatch_task security findings PR review. Eight MCP page-size limits in `getMcpLimits()` use bare constants without env var overrides, violating Principle XI (No Hardcoded Values).

## Problem

In `apps/api/src/routes/mcp.ts`, the `getMcpLimits()` function returns eight page-size limits as bare constants:
- `taskListLimit`, `taskListMax`, `taskSearchMax`
- `sessionListLimit`, `sessionListMax`
- `messageListLimit`, `messageListMax`, `messageSearchMax`

All other limits in the same function use `parsePositiveInt(env.VAR, DEFAULT)`. These eight do not.

## Implementation Checklist

- [ ] Add 8 optional `string?` fields to the `Env` interface in `apps/api/src/index.ts`
- [ ] Replace bare constants in `getMcpLimits()` with `parsePositiveInt(env.MCP_*, DEFAULT_*)` calls
- [ ] Document the 8 new vars in `apps/api/.env.example`

## Acceptance Criteria

- [ ] All 8 page-size limits are configurable via environment variables
- [ ] Default behavior is unchanged (same default values)
- [ ] Existing tests pass
