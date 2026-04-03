# Replace Source-Contract Tests with Behavioral Tests (web)

## Problem

7 test files in `apps/web/tests/` use `readSource()`/`readFileSync` to read component source as strings and assert substrings. This is prohibited by `.claude/rules/02-quality-gates.md`. These tests prove code *presence* not *behavior*.

## Implementation Checklist

- [x] 1. Delete source-contract describe block from `landing.test.tsx` (keep behavioral navigation tests)
- [x] 2. Fix source fallback in `markdown-renderer.test.tsx` mermaid securityLevel test
- [x] 3. Replace `tdf-8-frontend-state-tracking.test.ts`: keep shared type tests, replace ProvisioningIndicator source-contract with behavioral test, remove file-existence test
- [x] 4. Write behavioral tests for SplitButton, delete source-contract from `chat-components.test.ts`
- [x] 5. Write behavioral tests for TaskSubmitForm, delete source-contract from `task-components.test.ts`
- [x] 6. Write behavioral tests for SessionHeader, delete `session-header.test.tsx`
- [x] 7. Delete `chat-components.test.ts` and `task-components.test.ts` — all behaviors covered by new + existing tests
- [x] 8. Verify zero `readSource`/`readFileSync` calls remain in `apps/web/tests/` (only theme-tokens.test.ts which is valid structural verification)
- [x] 9. All tests pass via `pnpm test` (4 pre-existing failures unrelated to this change)

## Acceptance Criteria

- [x] Zero remaining `readSource` or `readFileSync` calls that read component source code as strings in `apps/web/tests/`
- [x] All replacement tests use `render()` + user interaction simulation (for interactive components)
- [x] Pure logic tests (shared types, chatMessagesToConversationItems) use direct function calls
- [x] All tests pass locally via `pnpm test`
- [x] No behavioral regressions (tests still cover the important behaviors)
