# Replace API Source-Contract Tests with Integration Tests

## Problem

9 test files in `apps/api/tests/unit/routes/` use `readFileSync`/`readSource` to read route handler source code as strings and assert substrings via `.toContain()`. This is explicitly prohibited by `.claude/rules/02-quality-gates.md` under "Prohibited Test Patterns". Additionally, 3 service test files use the same anti-pattern.

## Research Findings

### Source-Contract Test Files (Route Tests)
1. **agent-sessions.test.ts** — Verifies agent session CRUD, concurrency guards, stop/resume endpoints
2. **chat-agent-session-id.test.ts** — Verifies chat session detail returns agentSessionId without filtering by status
3. **tasks.test.ts** — Verifies task CRUD, status transitions, dependencies, delegation, callbacks
4. **nodes.test.ts** — Verifies node CRUD, lifecycle callbacks, health transitions, stop/delete semantics
5. **projects.test.ts** — Verifies project CRUD, auth, runtime config, timeout validation
6. **terminal.test.ts** — Verifies terminal token issuance, activity tracking
7. **workspace-messages.test.ts** — Already replaced by `tests/workers/workspace-messages.test.ts`
8. **workspaces.test.ts** — Verifies workspace CRUD, naming, recovery, cleanup
9. **workspace-session-hook.test.ts** — Verifies chat session creation on workspace create

### Service Test Files
10. **task-runner-do-helpers.test.ts** — Verifies parseEnvInt, computeBackoffMs, isTransientError helpers
11. **configurable-limits.test.ts** — Verifies all system limits are configurable via env vars
12. **node-stop.test.ts** — Verifies node stop deletes infrastructure and marks resources as 'deleted'

### Strategy
- **Delete all source-contract tests** — they read source as strings, which is prohibited
- **Write worker integration tests** for callback-auth routes using `SELF.fetch()` + `signCallbackToken`
- **Write function-level unit tests** for exported service helpers (parseEnvInt, computeBackoffMs, etc.)
- **Write behavioral tests** for configurable limits via health endpoint and function calls

## Implementation Checklist

- [ ] 1. Delete `apps/api/tests/unit/routes/workspace-messages.test.ts` (already replaced by worker test)
- [ ] 2. Delete and replace `apps/api/tests/unit/routes/agent-sessions.test.ts`
- [ ] 3. Delete and replace `apps/api/tests/unit/routes/chat-agent-session-id.test.ts`
- [ ] 4. Delete and replace `apps/api/tests/unit/routes/tasks.test.ts`
- [ ] 5. Delete and replace `apps/api/tests/unit/routes/nodes.test.ts`
- [ ] 6. Delete and replace `apps/api/tests/unit/routes/projects.test.ts`
- [ ] 7. Delete and replace `apps/api/tests/unit/routes/terminal.test.ts`
- [ ] 8. Delete and replace `apps/api/tests/unit/routes/workspaces.test.ts`
- [ ] 9. Delete and replace `apps/api/tests/unit/routes/workspace-session-hook.test.ts`
- [ ] 10. Replace `apps/api/tests/unit/task-runner-do-helpers.test.ts` with function-level tests
- [ ] 11. Replace `apps/api/tests/unit/services/configurable-limits.test.ts` with behavioral tests
- [ ] 12. Replace `apps/api/tests/unit/services/node-stop.test.ts` with behavioral tests
- [ ] 13. Verify zero `readFileSync`/`readSource` calls reading route source in `apps/api/tests/`
- [ ] 14. All tests pass via `pnpm test`

## Acceptance Criteria

- [ ] Zero remaining `readSource` or `readFileSync` calls that read route/service source code as strings in `apps/api/tests/`
- [ ] All replacement tests invoke actual functions or route handlers and assert on outputs/responses
- [ ] All tests pass locally via `pnpm test`
- [ ] No reduction in meaningful test coverage (behavioral contracts are preserved)

## References
- `.claude/rules/02-quality-gates.md` — Prohibited Test Patterns
- `apps/api/tests/workers/workspace-messages.test.ts` — Gold standard for worker integration tests
- `apps/api/tests/workers/worker-smoke.test.ts` — Smoke test pattern
