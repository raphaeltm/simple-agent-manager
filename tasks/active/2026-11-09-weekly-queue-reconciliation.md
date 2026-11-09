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
- [ ] Classify every backlog file; delete only shipped, superseded, obsolete or duplicate entries
      with evidence; keep anything plausibly open
- [ ] Record a one-line rationale per removed backlog file in the PR description

## Acceptance criteria

- [ ] `tasks/active/` contains only this task while the PR is open
- [ ] Every removed backlog file has a one-line rationale in the PR description
- [ ] No backlog file with plausibly open work is removed
- [ ] CI green
