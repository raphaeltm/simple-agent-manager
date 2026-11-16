# Weekly queue and memory reconciliation (2026-11-16)

SAM task `cron-f8d925a2…b96911`. Task-file-only cleanup: no code, config or public docs change.

## Problem

The work-tracking surfaces drift from reality: `tasks/active/` files stay after their PRs merge,
backlog entries outlive the work that resolved them, and stale open PRs sit without a status.

## Research findings

- Last sweep: PR #2602 (2026-11-09) archived every active file and classified all 272 backlog files.
  Since then `tasks/active/` grew 0 → 31 and `tasks/backlog/` 260 → 300 (40 added, 12 modified).
- 28 of 31 active files map to merged PRs (#2597–#2757). Three stay active because live agents own
  them: `merge-streamed-chunks` (open #2773, default-ON follow-up pending), `ship-codex-security-fixes`
  (#2771 and #2772 open), `cut-wasted-do-sqlite-row-writes` (cost coordinator `01M7CVZN…` still
  running post-deploy measurement).
- Draft #2778 edits four of the archived active files and ten backlog files (rule-path references
  only); git rename detection carries those edits across the move.
- Open PRs older than 7 days: #2376, #2308, #2265, #2062, #1788. PR Shepherd (`cron-380c69…`) owns
  general PR triage this run; this task posts only the weekly park/status comment.

## Checklist

- [x] Classify every `tasks/active/` file against merged PRs; archive the shipped ones with a dated
      reconciliation note; tick only boxes the merge proves.
- [x] Weekly status comment on each open PR older than 7 days.
- [x] Classify the 40 new backlog files in full and re-check the 260 older ones against PRs merged since
      2026-11-09; remove only proven shipped/obsolete/duplicate entries, one-line rationale each.
- [x] PR description lists every archived and removed file with its evidence.

## Acceptance criteria

- [x] Every file left in `tasks/active/` has a live owner or open PR.
- [x] Every removed backlog file has PR or code evidence in the PR description; uncertain files stay.
- [x] No non-task file changes in the diff.

## Results

- `tasks/active/`: 31 → 3 (+ this file). 28 archived with a dated note; 3 kept with live owners.
- `tasks/backlog/`: 300 → 292. 8 moved to `tasks/archive/` with a dated verdict note (3 SHIPPED,
  4 DUPLICATE folded into a survivor, 1 SUPERSEDED). 21 PARTIAL files got a dated progress note;
  2 survivors received the folded criteria. 269 KEEP unchanged.
- Nothing was deleted: obsolete and duplicate files moved to the archive with a pointer, so the history
  stays searchable.

## Review

- task-completion-validator: PASS, no CRITICAL/HIGH. MEDIUM (Vultr onboarding archived as SHIPPED with two
  verification criteria unmet) fixed by returning it to the backlog as PARTIAL, narrowed to the onboarding
  Playwright and staging checks. LOWs fixed: three boxes that also claimed a smoke/health/rollout
  observation were unticked again, and the tunnel-lifecycle note now points to where the parent's staging
  E2E evidence lives.
- CodeRabbit: requested 06:21 UTC; replied "Review limit reached" (free OSS quota) and "Review rate
  limited". No review; wait ended per rule 25.
