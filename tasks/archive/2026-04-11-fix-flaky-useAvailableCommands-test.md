# Fix Flaky useAvailableCommands Test

**Status**: Resolved
**Resolved by**: `tasks/active/2026-07-04-fix-flaky-tests-at-root.md`

## Resolution

The refresh-key test was already structurally sound with its assertions inside `waitFor`.
The remaining CI-only coverage flake was addressed by raising Testing Library's async
utility timeout in `apps/web/tests/setup.ts`, giving coverage-instrumented React
state updates a realistic bound without adding Vitest retries or CI reruns.

## Problem
`apps/web/tests/unit/hooks/useAvailableCommands.test.ts` — the "re-fetches when refreshKey changes" test fails intermittently in CI when run with coverage (`vitest run --coverage`) but passes locally. The `waitFor` assertion at line 176 races with the mock state update from the rerender.

## Context
- Discovered during PR #673 CI runs
- Passes on main CI but fails on feature branches (suggests timing sensitivity)
- Passes locally without coverage
- Not related to any trigger execution changes

## Acceptance Criteria
- [x] Fix the timing issue in the test (likely needs a `waitFor` around the final assertion)
- [x] Test passes reliably in CI with coverage enabled
