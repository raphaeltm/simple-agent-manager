# L4: split SettingsComputeUsage.tsx into components/ai-usage (pure move)

## Problem

`apps/web/src/pages/SettingsComputeUsage.tsx` is 776 lines on main, over the 500-line limit in
`.claude/rules/18-file-size-limits.md`. Self-host landing slice L4 (coordinator task
`01M7AF82KG9C78WAABTG3V1MN1`) moves the AI usage and AI budget sections into
`apps/web/src/components/ai-usage/`, using the integration branch `sam/selfhost-pass-2` only as the
target shape. Pure move: no behaviour change. The coordinator merges, not the author.

## Research Findings

- Main's page has 11 top-level statements: `formatHours`, `formatDuration`, `formatCost`,
  `formatTokens`, `truncateModel`, `AI_PERIODS`, `AiUsageSection`, `BudgetBar`,
  `BudgetSettingsSection`, `QuotaProgressBar`, `SettingsComputeUsage`.
- The branch's own pure-move commit `34dbd5d46` has the same split; later branch commits
  (`eba74739a`, `55f8be286`) add the monthly-cap-unavailable behaviour and
  `MonthlyCapUnavailableNote.tsx`. Main has no such code, so it stays out.
- The branch renamed `BudgetSettingsSection` to `AiBudgetSettingsSection`, which changes the page's
  JSX line. Kept main's name to stay inside the "only import/export lines differ" rule.
- Consumers: `App.tsx` lazy-loads the page by name `SettingsComputeUsage` (unchanged);
  `tests/playwright/fixtures/native-hardware-harness.tsx` imports the page (unchanged). No unit
  test imports the moved symbols. Playwright audits: `compute-usage-audit.spec.ts`,
  `ai-usage-audit.spec.ts`.
- Overlap check (open PRs, active tasks touching SettingsComputeUsage or components/ai-usage): none.

## Implementation Checklist

- [x] Mechanical split by line range from `origin/main` (`.tmp/l4/split.py`, not committed)
- [x] `format.ts` (`formatCost`, `formatTokens`, `truncateModel`)
- [x] `AiUsageSection.tsx` (`AI_PERIODS`, `AiUsageSection`)
- [x] `AiBudgetSettingsSection.tsx` (`BudgetBar`, `BudgetSettingsSection`)
- [x] Page keeps `formatHours`, `formatDuration`, `QuotaProgressBar`, `SettingsComputeUsage`
- [x] Proof script (`.tmp/l4/verify.cjs`): 11/11 identical, line multisets differ only in import
      lines, blanks and five `export ` keywords; shown to discriminate
- [ ] lint, typecheck, web tests, build
- [ ] Playwright visual comparison with main at 375 px and 1280 px
- [ ] ui-ux-specialist and task-completion-validator reviews
- [ ] Staging deploy and live check of Settings > Usage
- [ ] PR ready for review (not merged)

## Acceptance Criteria

- [ ] Every moved symbol byte-identical to main apart from import/export lines (proof output in PR)
- [ ] All files under 500 lines
- [ ] Existing tests pass with no test file changes
- [ ] Screenshots at 375 px and 1280 px identical to main
- [ ] Staging Settings > Usage renders LLM usage, budget and compute sections with no console errors
