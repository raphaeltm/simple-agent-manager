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
- [ ] Extract task get/list/search to authorized operations and adapt workspace handlers.
- [ ] Extract chat read/search to authorized operations and adapt workspace handlers.
- [ ] Extract idea search/get/create/update to authorized operations and adapt workspace handlers.
- [ ] Extract knowledge search and profiles list to authorized operations and adapt workspace handlers.
- [ ] Decouple touched services from `McpTokenData`.
- [ ] Add real SQLite attack/control tests and guard deletion checks (attack/control tests added; deletion checks pending).
- [x] Add representative adapter parity tests; keep existing MCP tests green.
- [ ] Run normal quality, specialist, staging and PR gates.

## Acceptance criteria

All listed workspace tools call shared operations, retain their names/schemas/response bytes for authorized callers, reject unauthorized users and cross-project access, and pass the stated tests and staging checks. `/sam` remains untouched.
