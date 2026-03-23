# Split MCP Routes into Subdirectory

## Problem

`apps/api/src/routes/mcp.ts` is 2,638 lines — well above the 500-line limit. All MCP tool handlers live in a single file. Split into a `routes/mcp/` directory following the existing pattern used by `routes/tasks/` and `routes/projects/`.

## Research Findings

- **Current file exports**: `mcpRoutes` (Hono app), `TokenRow` (interface), `groupTokensIntoMessages` (function)
- **External imports**: Only `apps/api/src/index.ts` imports from `routes/mcp` (`mcpRoutes`)
- **Test imports**: `apps/api/tests/unit/routes/mcp.test.ts` imports `groupTokensIntoMessages` and `TokenRow` from `routes/mcp`
- **Pattern to follow**: `routes/tasks/index.ts` creates a Hono app and mounts sub-routers; `routes/tasks/_helpers.ts` has shared utilities
- **Shared infrastructure** (lines 56–718): JSON-RPC types, constants, limits, rate limiting, auth — used by all tool handlers
- **Tool categories** map cleanly to handler functions at these line ranges:
  - Instruction tools: `handleGetInstructions` (720–791), `handleRequestHumanInput` (1088–1192)
  - Task tools: `handleUpdateTaskStatus` (792–893), `handleCompleteTask` (894–1085), `handleDispatchTask` (1195–1633), `handleListTasks` (1636–1705), `handleGetTaskDetails` (1706–1769), `handleSearchTasks` (1770–1838)
  - Session tools: `handleListSessions` (1839–1903), `handleGetSessionMessages` (1904–2024), `handleSearchMessages` (1968–2024) + `TokenRow`/`groupTokensIntoMessages` (1877–1966)
  - Idea tools: `handleLinkIdea`–`handleSearchIdeas` (2025–2513) + `resolveSessionId` helper (2031–2041)

## Implementation Checklist

- [ ] Create `apps/api/src/routes/mcp/` directory
- [ ] Create `_helpers.ts` with shared infrastructure: JSON-RPC types, constants, limits, rate limiting, auth, `sanitizeUserInput`, `validateRoles`, `MCP_TOOLS`, `ACTIVE_STATUSES`, protocol constants
- [ ] Create `instruction-tools.ts` with `handleGetInstructions` and `handleRequestHumanInput`
- [ ] Create `task-tools.ts` with `handleUpdateTaskStatus`, `handleCompleteTask`, `handleDispatchTask`, `handleListTasks`, `handleGetTaskDetails`, `handleSearchTasks`
- [ ] Create `session-tools.ts` with `handleListSessions`, `handleGetSessionMessages`, `handleSearchMessages`, `TokenRow`, `groupTokensIntoMessages`
- [ ] Create `idea-tools.ts` with `handleLinkIdea`, `handleUnlinkIdea`, `handleListLinkedIdeas`, `handleFindRelatedIdeas`, `handleCreateIdea`, `handleUpdateIdea`, `handleGetIdea`, `handleListIdeas`, `handleSearchIdeas`, `resolveSessionId`
- [ ] Create `index.ts` barrel: creates `mcpRoutes`, mounts the POST handler with auth/rate-limit/JSON-RPC dispatch, re-exports `mcpRoutes`, `TokenRow`, `groupTokensIntoMessages`
- [ ] Delete old `apps/api/src/routes/mcp.ts`
- [ ] Verify all files are under 500 lines
- [ ] Run typecheck, lint, tests, build

## Acceptance Criteria

- [ ] All existing tests pass without modification
- [ ] `mcpRoutes`, `TokenRow`, `groupTokensIntoMessages` importable from `routes/mcp`
- [ ] No behavior changes — purely organizational refactor
- [ ] Each file under 500 lines
- [ ] Follows `routes/tasks/` pattern (index.ts barrel + `_helpers.ts` + category files)
