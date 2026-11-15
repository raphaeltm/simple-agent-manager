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
- [x] lint, typecheck, web tests, build (`pnpm check:fast` 22/22; web vitest 5,228/5,228; `tsc`; `vite build`)
- [x] Playwright visual comparison with main at 375 px and 1280 px (`.tmp/l4/compare.spec.ts`: 28/28 PNGs byte-identical, request logs identical)
- [x] ui-ux-specialist and task-completion-validator reviews (both PASS)
- [x] Staging deploy and live check of Settings > Usage (Deploy Staging 43666884157 on d109a0c6d; before/after API JSON and page text identical, mobile screenshots byte-identical, 0 console errors)
- [ ] CodeRabbit requested once ready; wait ~15 min (silence does not block)
- [ ] PR ready for review. DO NOT MERGE: the coordinator (task 01M7AF82KG9C78WAABTG3V1MN1) verifies and merges

## Acceptance Criteria

- [x] Every moved symbol byte-identical to main apart from import/export lines (proof output in PR)
- [x] All files under 500 lines
- [x] Existing tests pass with no test file changes
- [x] Screenshots at 375 px and 1280 px identical to main
- [x] Staging Settings > Usage renders LLM usage, budget and compute sections with no console errors

## Left for a later slice

- `components/ai-usage/MonthlyCapUnavailableNote.tsx`: new behaviour (monthly cap unavailable without AI Gateway cost data); no counterpart on main.
- `AiBudgetSettingsSection.tsx` monthly-cap-unavailable logic from branch commits `eba74739a`, `55f8be286` (`capAvailable`, clear-cap-on-save, conditional copy/input, `monthlyCostCapAvailable` in shared types).
- Rename `BudgetSettingsSection` to `AiBudgetSettingsSection` (would change the page's JSX line).
- Header doc comment on `format.ts` (not a line on main).

## Pre-existing (found by ui-ux-specialist, unchanged by this move, not in scope)

- `AiUsageSection` hides loaded data during a period-switch refetch (`data && !loading`), rule 48.
- Hand-rolled fetch hooks instead of TanStack Query in both sections.
