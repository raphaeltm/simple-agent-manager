# Weekly queue reconciliation (2026-11-09)

SAM task `cron-95d1a1792d3440f08f38dbc6dc0d3af59ef0e12b71de7f18963d7aff02c18bda`. Output branch
`sam/weekly-queue-memory-reconciliation-c18bda`. Task-file-only change: no code, so staging
verification does not apply.

## Problem

The repository task queue drifts from reality: files stay in `tasks/active/` after their PRs
merge, and `tasks/backlog/` accumulates shipped, superseded and duplicate entries. Old open PRs
need a weekly status nudge so their park decisions stay visible.

## Research findings

- `tasks/active/` had 14 files (not ~75). Every one maps to a merged PR (#2475, #2494, #2502,
  #2504, #2506, #2526, #2536, #2538/#2540, #2542, #2558, #2576, #2595). Production deploy on
  `e727f0259` (2026-11-09 01:29 UTC) succeeded and contains all of them.
- The archived full-installer task still lists open work (shared-engine CI parity, adversarial
  audit gaps, release dependencies). Carried to
  `tasks/backlog/2026-11-09-installer-shared-engine-follow-ups.md` so it is not lost.
- `tasks/backlog/` had 272 files, classified per file by evidence (merged PR or code path).
- Open PRs older than 7 days: #2376, #2308, #2265, #2062, #1788. The PR Shepherd defers weekly
  consolidated reminders on them to this sweep.

## Checklist

- [x] Archive the 14 shipped active tasks with a reconciliation note each; tick checkboxes that
      only recorded the merge or deploy
- [x] Carry the installer task's open remainder to a backlog file
- [x] Post a weekly status/park comment on each PR older than 7 days
- [x] Classify every backlog file; delete only shipped, superseded, obsolete or duplicate entries
      with evidence; keep anything plausibly open (272 classified: 13 removed, 120 PARTIAL,
      139 KEEP; duplicates' unique criteria folded into their canonical files)
- [x] Add reconciliation notes to the 13 PARTIAL files with new progress since the last sweep
- [x] Record a one-line rationale per removed backlog file in the PR description

## Acceptance criteria

- [x] `tasks/active/` contains only this task while the PR is open (archived before merge)
- [ ] Every removed backlog file has a one-line rationale in the PR description
- [x] No backlog file with plausibly open work is removed (each removal spot-checked against code)
- [ ] CI green

## Notes

- Removed files and rationale: see the PR description.
- Findings left for humans (not changed here): `rateLimitAnonymous`
  (`apps/api/src/middleware/rate-limit.ts`) has no callers since #2588; the `origin/harness/develop`
  branch (PRs #943–#953) needs a land-or-retire decision; main CI on `80bb3b6de` (#2598) failed in
  `Devcontainer Volume Mount`, so that merge has not deployed yet.
