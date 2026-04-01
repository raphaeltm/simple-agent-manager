# Replace Source-Contract Tests with Behavioral Tests

**Created**: 2026-04-01
**Priority**: High
**Context**: `.claude/rules/02-quality-gates.md` prohibits `readSource`/`readFileSync` source-contract tests for interactive components

## Problem

Five test files use `readSource()` (a wrapper around `readFileSync`) to read component source code as strings and assert substrings via `.toContain()`. These tests prove code is *present*, not that it *works*. They provide zero behavioral coverage and create false confidence.

## Research Findings

### Files to Replace

| File | What it tests | Replacement strategy |
|------|--------------|---------------------|
| `apps/web/tests/unit/task-components.test.ts` | TaskSubmitForm props/validation, ProjectChat submit, API client | Render TaskSubmitForm + simulate form interactions |
| `apps/web/tests/unit/chat-components.test.ts` | ProjectChat sidebar, ProjectMessageView, SplitButton, routing | Render SplitButton + test interactions; mock hooks for larger components |
| `apps/web/tests/unit/components/session-header.test.tsx` | SessionHeader mark-complete flow, UI structure | Render SessionHeader + test mark-complete confirmation dialog flow |
| `apps/web/tests/unit/tdf-8-frontend-state-tracking.test.ts` | Execution step labels, ProvisioningIndicator, file removal | Preserve valid shared-type tests; render ProvisioningIndicator |
| `apps/api/tests/unit/project-vm-size.test.ts` | Project CRUD defaultVmSize, task run/submit VM size precedence | Use Hono app.request() pattern with mocked DB |

### Test Infrastructure Available
- `@testing-library/react` with `render`, `screen`, `fireEvent`, `waitFor`
- `@testing-library/user-event` for realistic interactions
- `@testing-library/jest-dom/vitest` for DOM matchers
- `vi.mock()` for module-level mocks
- `vi.useFakeTimers()` for timer-based components
- jsdom environment configured in vitest.config.ts
- Hono `app.request()` pattern for API route testing (see dashboard.test.ts)

### Key Patterns to Follow
- Mock API functions with `vi.mock('../../src/lib/api', ...)`
- Mock React Router hooks: `vi.mock('react-router-dom', ...)`
- Mock custom hooks for components that are heavy in hook dependencies
- For API tests: `buildApp()` + `buildMockDB()` + `app.request()` pattern

## Implementation Checklist

- [ ] 1. Replace `task-components.test.ts` — render TaskSubmitForm, test validation and submission
- [ ] 2. Replace `chat-components.test.ts` — render SplitButton (interactions), test routing structure, mock hooks for ProjectChat/ProjectMessageView
- [ ] 3. Replace `session-header.test.tsx` — render SessionHeader, test mark-complete flow with Dialog
- [ ] 4. Replace `tdf-8-frontend-state-tracking.test.ts` — preserve shared-type tests, render ProvisioningIndicator
- [ ] 5. Replace `project-vm-size.test.ts` — use Hono app.request() for PATCH/GET/POST handlers
- [ ] 6. Verify zero readSource/readFileSync calls remain on component source
- [ ] 7. Archive backlog task `tasks/backlog/2026-03-01-migrate-source-contract-tests.md`
- [ ] 8. Run full test suite (`pnpm test`) to confirm all pass

## Acceptance Criteria

- [ ] Zero remaining `readSource` or `readFileSync` calls that read component/route source code as strings
- [ ] All replacement tests use `render()` + user interaction simulation (web) or real handler invocation (API)
- [ ] All tests pass locally via `pnpm test`
- [ ] Backlog task archived

## References

- `.claude/rules/02-quality-gates.md` — Prohibited Test Patterns
- `docs/notes/2026-03-01-new-chat-button-postmortem.md` — Source-contract tests failed to catch broken button
- `apps/api/tests/unit/routes/dashboard.test.ts` — Example good API route test pattern
- `apps/web/tests/unit/hooks/useChatWebSocket.behavioral.test.ts` — Example good hook test pattern
