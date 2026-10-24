# T8 PR1 — Ideas list with state derived from linked work

Screenshot evidence for PR #2436, referenced from the PR body by pinned blob URL because a
local path dies with the agent workspace (`.claude/rules/17`).

Two sources, and the distinction matters when reading them:

- `t8-*` are from **staging**, against the real deployed Worker and a real project holding 81
  pre-existing ideas that nobody wrote for a test
  (`apps/web/tests/playwright/staging-ideas-derived-status.spec.ts`).
- `ideas-empty-main-column-*` are from the **local audit** against mocks
  (`apps/web/tests/playwright/ideas-list-audit.spec.ts`), because reaching that state needs a
  search matching only a done idea, which a two-item fixture makes exact.

Every captured surface asserts `assertNoOverflow` (which includes the clipped-overflow walk)
at the moment of capture.
