# Fix Flaky useAvailableCommands Test

## Problem
`apps/web/tests/unit/hooks/useAvailableCommands.test.ts` — the "re-fetches when refreshKey changes" test fails intermittently in CI when run with coverage (`vitest run --coverage`) but passes locally. The `waitFor` assertion at line 176 races with the mock state update from the rerender.

## Context
- Discovered during PR #673 CI runs
- Passes on main CI but fails on feature branches (suggests timing sensitivity)
- Passes locally without coverage
- Not related to any trigger execution changes

## Acceptance Criteria
- [ ] Fix the timing issue in the test (likely needs a `waitFor` around the final assertion)
- [ ] Test passes reliably in CI with coverage enabled

---

_Reconciled 2026-09-30 (weekly queue reconciliation): moved from `tasks/backlog/` to `tasks/archive/` as superseded (not built as written). Evidence: Proposed fix landed (25f329b88, #694); root cause owned by tasks/backlog/2026-07-04-fix-flaky-tests-at-root.md, which says to archive this file._
