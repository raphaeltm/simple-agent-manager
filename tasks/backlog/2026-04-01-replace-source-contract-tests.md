# Replace Source-Contract Tests with Behavioral Integration Tests

> **Reconciliation 2026-10-05:** PR #2225 (9ef726c20) deleted the agent-settings-callback source-contract block from `apps/api/tests/unit/project-agent-defaults.test.ts`. That block read `routes/workspaces/runtime.ts`. It was replaced by a behavioral route test on a real SQL engine, `apps/api/tests/unit/routes/workspace-agent-settings-callback.test.ts:47-194` (`app.request`, no `readFileSync`). Still open: every item in the 2026-09-30 block. `project-agent-defaults.test.ts` still reads `routes/tasks/submit.ts` and `routes/mcp/dispatch-tool.ts` (`:391-415`), so all 28 listed files remain. The detector regex in `scripts/quality/check-source-contract-tests.ts:52-55` is still unfixed. No new route source-contract tests were added this week.

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** all 9 named files in `apps/api/tests/unit/routes/` were deleted by PR #598
>   (8603139c7), recorded as done in
>   `tasks/archive/2026-04-03-replace-api-source-contract-tests.md`. `routes/terminal.test.ts`
>   was later rewritten as a behavioral test (`app.request`, no `readFileSync`).
> - **Still open:** the "zero `readFileSync` of route source in `apps/api/tests/`" criterion
>   fails.
>   - 28 API test files still read `src/routes/*` and assert with `toContain`/`toMatch`.
>     Classify each (legitimate structural check vs prohibited source-contract test), then
>     migrate or justify it:
>     - `integration/`: agent-profiles, composable-credentials-routes, compute-quotas,
>       compute-usage, multi-workspace-nodes, node-selection, workspace-dispatch-race,
>       workspace-lifecycle-sync.
>     - `unit/`: cf-container-runtime-contract, chat-session-management,
>       durable-objects/task-runner-initial-prompt, node-role-exemption, project-agent-defaults,
>       project-default-provider, recovery-resilience, resolve-credential-source,
>       skill-submit-paths, task-agent-profile-display-routes, task-failure-writer-coverage,
>       task-runner-do-service, workspace-lifecycle.
>     - `unit/routes/`: ai-proxy-model-tier-coverage, deploy-release-route-order,
>       task-callback-awaiting-followup.
>     - `unit/services/`: configurable-limits (route reads re-added at `:249` after #598),
>       node-ip-validation, workspace-branch-guard-coverage,
>       workspace-lifecycle-finalizer-coverage.
>   - CI cannot see them: the regex in `scripts/quality/check-source-contract-tests.ts:52–55`
>     misses `readFileSync(resolve(process.cwd(), 'src/...'))` because `[^)]*` stops at the `)`
>     of `cwd()`, so `pnpm quality:source-contract-tests` reports 0 violations. Fix the detector.
>   - `2026-08-11-migrate-remaining-source-contract-ui-tests.md` covers only 2 of the 28
>     (project-agent-defaults, project-default-provider; UI blocks only). Its "Related prior art"
>     note misdescribes this file: the six `apps/web` files it lists were handled in #598.
> - **Moot/dropped:** "9 replacement files use `app.request()`". #598 replaced them with a
>   Miniflare worker test (`apps/api/tests/workers/route-auth-validation.test.ts`) and
>   function-level tests instead.

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
