# Replace Source-Contract Tests with Behavioral Integration Tests

## Problem

9 test files in `apps/api/tests/unit/routes/` use `readFileSync` to read route handler source code as strings and assert substrings via `.toContain()`. This is explicitly prohibited by `.claude/rules/02-quality-gates.md` under "Prohibited Test Patterns". These tests prove code is *present*, not that it *works*.

## Research Findings

### Files to Delete (9 source-contract tests)
1. `agent-sessions.test.ts` — session lifecycle endpoints, concurrency guards
2. `chat-agent-session-id.test.ts` — chat session detail fetches agent session ID
3. `nodes.test.ts` — node CRUD, lifecycle, heartbeat health
4. `projects.test.ts` — project CRUD, auth, limits, encryption
5. `tasks.test.ts` — task CRUD, status transitions, dependencies
6. `terminal.test.ts` — terminal token issuance, activity tracking
7. `workspace-messages.test.ts` — message batch POST, validation
8. `workspace-session-hook.test.ts` — workspace creation creates chat session
9. `workspaces.test.ts` — workspace CRUD, lifecycle

### Replacement Pattern
Follow established behavioral test pattern (e.g., `admin-observability.test.ts`, `dashboard.test.ts`):
- Mock auth/error middleware, mock service layer
- Create Hono app, mount routes, call `app.request()`, assert HTTP responses

## Implementation Checklist

- [ ] Delete and replace `agent-sessions.test.ts`
- [ ] Delete and replace `chat-agent-session-id.test.ts`
- [ ] Delete and replace `nodes.test.ts`
- [ ] Delete and replace `projects.test.ts`
- [ ] Delete and replace `tasks.test.ts`
- [ ] Delete and replace `terminal.test.ts`
- [ ] Delete and replace `workspace-messages.test.ts`
- [ ] Delete and replace `workspace-session-hook.test.ts`
- [ ] Delete and replace `workspaces.test.ts`
- [ ] Verify zero readFileSync/readSource calls remain
- [ ] All tests pass via pnpm test

## Acceptance Criteria

- [ ] All 9 source-contract files deleted
- [ ] 9 replacement files use app.request() pattern
- [ ] Zero readFileSync/readSource on route source code in apps/api/tests/
- [ ] All tests pass locally
