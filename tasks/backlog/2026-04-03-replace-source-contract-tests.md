# Replace Source-Contract Tests with Behavioral Tests

## Problem

7 test files in `apps/web/tests/` use `readSource()`/`readFileSync` to read component source as strings and assert substrings. This is prohibited by `.claude/rules/02-quality-gates.md`. These tests prove code *presence* not *behavior*.

## Research Findings

### File Classification

| File | Status | Action |
|------|--------|--------|
| `chatMessagesToConversationItems.test.ts` | Already behavioral (742 lines) | No changes needed |
| `markdown-renderer.test.tsx` | Mostly behavioral, 1 source fallback | Fix one test |
| `landing.test.tsx` | Mixed: source-contract + behavioral | Delete source-contract block, keep behavioral |
| `tdf-8-frontend-state-tracking.test.ts` | Mixed: valid shared type tests + source-contract | Keep shared type tests, replace/remove source-contract |
| `task-components.test.ts` | Pure source-contract | Full replacement |
| `chat-components.test.ts` | Pure source-contract | Full replacement |
| `session-header.test.tsx` | Pure source-contract | Full replacement |

### Components Needing Behavioral Tests

1. **SplitButton** (`components/ui/SplitButton.tsx`) - Standalone, props: primaryLabel, onPrimaryAction, options, disabled, loading. Behaviors: click primary, toggle dropdown, click option, click-outside close, Escape close.

2. **TaskSubmitForm** (`components/task/TaskSubmitForm.tsx`) - Props: projectId, hasCloudCredentials, onRunNow, onSaveToBacklog. Behaviors: type title, submit via Run Now, validate empty title, validate credentials, expand advanced options, Save to Backlog.

3. **SessionHeader** (`components/project-message-view/SessionHeader.tsx`) - Props: projectId, session, sessionState, taskEmbed, workspace, node, etc. Behaviors: expand details, Mark Complete button (visible when eligible), confirmation dialog, completing state, error display.

4. **ProvisioningIndicator** (`pages/project-chat/ProvisioningIndicator.tsx`) - Props: state (ProvisioningState), bootLogCount, onViewLogs. Behaviors: shows step label, shows progress segments, shows View Logs button, shows error.

### Test Infrastructure

- jsdom environment, `@testing-library/react`, `@testing-library/jest-dom`
- Mock patterns: `vi.hoisted()` + `vi.mock()`, MemoryRouter for routing, passthrough UI mocks
- Existing behavioral test patterns in `project-message-view.test.tsx`, `task-form.test.tsx`, `auth-provider.test.tsx`

## Implementation Checklist

- [ ] 1. Delete source-contract describe block from `landing.test.tsx` (keep behavioral navigation tests)
- [ ] 2. Fix source fallback in `markdown-renderer.test.tsx` mermaid securityLevel test
- [ ] 3. Replace `tdf-8-frontend-state-tracking.test.ts`: keep shared type tests, replace ProvisioningIndicator source-contract with behavioral test, remove file-existence test
- [ ] 4. Write behavioral tests for SplitButton, delete source-contract from `chat-components.test.ts`
- [ ] 5. Write behavioral tests for TaskSubmitForm, delete source-contract from `task-components.test.ts`
- [ ] 6. Write behavioral tests for SessionHeader, delete `session-header.test.tsx`
- [ ] 7. Replace remaining source-contract tests in `chat-components.test.ts` with behavioral tests where feasible (ProjectChat page, ProjectMessageView, routing)
- [ ] 8. Verify zero `readSource`/`readFileSync` calls remain in `apps/web/tests/` (excluding test infrastructure)
- [ ] 9. All tests pass via `pnpm test`

## Acceptance Criteria

- [ ] Zero remaining `readSource` or `readFileSync` calls that read component source code as strings in `apps/web/tests/`
- [ ] All replacement tests use `render()` + user interaction simulation (for interactive components)
- [ ] Pure logic tests (shared types, chatMessagesToConversationItems) use direct function calls
- [ ] All tests pass locally via `pnpm test`
- [ ] No behavioral regressions (tests still cover the important behaviors)

## References

- `.claude/rules/02-quality-gates.md` — Prohibited Test Patterns
- `apps/web/tests/unit/components/project-message-view.test.tsx` — Existing behavioral test pattern
- `apps/web/tests/unit/components/project/task-form.test.tsx` — Form interaction pattern
