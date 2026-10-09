# SAM Connector P0 operations foundation

## Problem

The workspace MCP server embeds platform operations in protocol handlers. Shared user-level surfaces need typed, authorized operations while preserving workspace agent responses.

## Research

- Workspace MCP handlers live in `apps/api/src/routes/mcp/` and serialize JSON-RPC responses with `_helpers.ts`.
- REST project authorization is in `middleware/project-auth.ts`; idea create requires `task:write` in `routes/tasks/crud.ts`.
- Project intent and operation catalog are in idea `01M4GJ0W0DS5BTKBM1YW0X5YC8` §4, §7, §15 and round-2 decisions.
- Existing task handlers mostly filter by project ID; the new operation must check current user membership.

## Checklist

- [x] Add typed operation contract, errors and registry with Valibot JSON Schema export.
- [x] Extract task get/list/search to authorized operations and adapt workspace handlers.
- [x] Extract chat read/search to authorized operations and adapt workspace handlers.
- [x] Extract idea search/get/create/update to authorized operations and adapt workspace handlers.
- [x] Extract knowledge search and profiles list to authorized operations and adapt workspace handlers.
- [x] Check touched services for `McpTokenData` coupling: none of these ten paths uses a service typed with it; only the workspace adapter retains the token type.
- [x] Add real SQLite attack/control tests and guard deletion checks. All eight deleted guards made their target attack tests fail; restored suite passed.
- [x] Add representative adapter parity tests; keep existing MCP tests green.
- [x] Run normal quality, specialist, staging and PR gates. Full local suite and PR CI passed; staging run 37972744647 verified all requested workspace tools from a real agent session and cleaned its resources. CodeRabbit and merge remain Phase 7 delivery gates.

## Intended behavior change

The selected workspace tools now check the session user's current active project membership on every read. Idea create/update also require `task:write`, matching REST. Revoked or viewer users can lose tool access that the old project-only filtering allowed.

## Acceptance criteria

All listed workspace tools call shared operations, retain their names/schemas/response bytes for authorized callers, reject unauthorized users and cross-project access, and pass the stated tests and staging checks. `/sam` remains untouched.
