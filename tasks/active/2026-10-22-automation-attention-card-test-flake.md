# Fix the flaky Automation attention-card unit test

## Problem

`apps/web/tests/unit/pages/automation-flows.test.tsx` → `overview` → "resumes a trigger SAM paused
after failures, from its attention card" fails intermittently in CI with
`Unable to find role="region" and name "Dependency audit"` (line 312). It blocked the backend
event-wait PR #2406 (CI runs 39711971082 and 39713636826; also 39708016041). That PR changes no
UI code. The test came from PR #2389 and was last touched by the merged UI PR #2405.

## Research Findings

- **Same code passes and fails.** PR #2406's CI Test job passed at 01:19 and 02:11 UTC and failed
  at 01:50, 02:32 and 02:51 UTC on 2026-10-22. Main `6d882363c` passed. PR #2406's
  `packages/shared` changes are type-only (a doc comment and a `matchedAt` type field), so the web
  tests run identical code on main and on the PR merge commit.
- **The card needs two requests in a row.** `useAutomationData` (`apps/web/src/pages/automation/data.ts`)
  reads the trigger list, then `useQueries` reads each paused trigger's recent runs
  (`recentRunsQueryOptions`). `triggerAttention()` (`model.ts`) only flags the trigger once its
  runs arrive, and `NeedsAttention` (`overview-sections.tsx`) renders nothing until then.
- **The first test is the coldest.** Instrumented locally: the first `findByRole` scan of the
  rendered overview took 195 ms cold vs 27 ms warm, and it runs between the runs request and the
  card's render. The card landed ~450 ms after render on an idle 8-core machine. CI runs with V8
  coverage on a loaded runner, roughly 2.5–3.5× slower, so the card lands at or past Testing
  Library's default 1 s `findBy` timeout. In failing CI runs the test failed at 1.4–2.4 s total; a
  passing main run took 1.96 s. So the outcome depends on where the time goes, not on the total.
- **Reproduced locally.** `taskset -c 0` with 5 busy loops on core 0 and `--coverage`: 1 of 3 runs
  failed with the identical error and DOM ("Your automations" rendered, no "Needs your attention").
  CPU saturation without coverage did not reproduce it.
- **Same race, quieter symptom.** "shows a viewer everything but no controls" asserts no `Resume`
  button without waiting for the card. Before the runs arrive that assertion passes vacuously
  (`.claude/rules/62` #5: an absence assertion needs a liveness assertion).
- Existing convention: slow tests in this file get an explicit budget with a one-line reason
  (the webhook create-flow test uses `{ timeout: 15_000 }`); other web tests pass `{ timeout }` to
  waits that cover multi-step loads (for example `workspace.test.tsx`).

## Implementation Checklist

- [ ] Add one named wait budget for the attention card (findBy `timeout`) and a matching test
      budget, with a comment saying why
- [ ] Use the budget in both tests that wait for the "Dependency audit" card
- [ ] Viewer test: wait for the card, then assert no `Resume` inside it and that the viewer's
      "Take a look" link is there
- [ ] Prove the fix: the throttled and coverage repro fails on the old test and passes every time on the new one
- [ ] Prove the viewer assertion discriminating: show `Resume` to viewers temporarily, and the test must go red
- [ ] Run the web unit suite with coverage (CI command), plus lint, typecheck and format checks

## Acceptance Criteria

- [ ] The three overview tests pass under the throttled and coverage repro across repeated runs (old code fails it)
- [ ] The viewer test fails if a viewer is shown `Resume` on the attention card
- [ ] `pnpm --filter @simple-agent-manager/web test:coverage` passes
- [ ] No product code, backend or PR #2406 changes

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/02-quality-gates.md`
- PR #2389, PR #2405, PR #2406
