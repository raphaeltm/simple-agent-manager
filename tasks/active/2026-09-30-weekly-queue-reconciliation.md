# Weekly queue reconciliation — 2026-09-30

**SAM task:** `01M3RBQBHV39B9SHDC4BWBR16B`
**Branch:** `sam/weekly-queue-memory-reconciliation-wbr16b`

## Problem

The repo's work-tracking surfaces drift from shipped reality: `/do` Phase 4 (archive the task
file) is routinely skipped, so merged work sits in `tasks/active/`, and `tasks/backlog/`
accumulates entries that shipped, were superseded, or duplicate each other. A queue that lists
finished work as open makes it impossible to see what is genuinely open.

This run reconciles `tasks/active/`, `tasks/backlog/` and open PRs older than seven days against
`main` at `2c009b565` (2026-09-30) and production state. The SAM memory half of the weekly task
(knowledge, ideas, policies) is done through SAM MCP tools and is not part of this PR's diff.

## Research findings

- **Counts at start:** `tasks/active/` 16 (the brief estimated ~75; last week's run,
  `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`, already took it from 182 to 1),
  `tasks/backlog/` 300 (the brief estimated ~260), `tasks/archive/` 1,118, plus a non-standard
  `tasks/completed/` with 2 files.
- **All 16 active files reached `main` through their own implementation PRs** (#2137, #2153,
  #2154, #2155, #2156, #2157, #2163, #2164, #2166, #2174, #2177, #2179, #2182/#2187, #2184, #2185,
  and #2014 for the ProjectData emergency). Production deploys succeeded through `main` HEAD
  (run for `2c009b565` at 02:19Z 09-30), so every one of those PRs is live.
- **Production evidence changes two verdicts** (read-only prod D1, 2026-09-30):
  - `2026-09-26-trustworthy-task-status`: PR #2153's conversation fallback still requires a
    `session_snapshots` row with `sleep_status='sleeping'`, which the 7-day purge has already
    deleted. Ten conversation tasks failed with "Task runtime is no longer live after 480
    minutes … workspace_deleted" after the fix deployed (09-26 23:54Z), the latest at 02:36Z today.
    The callback half shipped; the day-7 half did not. Not archivable as done.
  - `2026-09-03-projectdata-production-capacity-emergency`: the root ProjectData DO measured
    10,297,155,584 bytes (103% of the 10^10 limit, `degraded`) at 05:34Z today; the SAM archive
    circuit breaker has been `open` since 2026-09-27 16:47:58Z (`attempts_exhausted:CompactArchiveTimeoutError`).
    Headline acceptance (≤ 9 GB) measurably unmet. Stays active.
  - `2026-09-27-fix-ghost-destroying-node-sweep`: prod has zero `destroying` nodes; the five
    providerless rows reached `deleted` at 16:47Z and 17:17Z on 09-27, right after #2163 deployed.
    Its post-deploy check is satisfied.
- **Bug found during the audit:** `update_idea` appends via
  `substr(description || … , 1, MCP_IDEA_CONTENT_MAX_LENGTH)` (`apps/api/src/routes/mcp/idea-tools.ts:398`),
  so once an Idea reaches 65,536 characters every later append is silently discarded. The ACP
  interactions Idea `01M3P2E0JJNQRXX020P65ZRKEJ` is exactly 65,536 characters and ends mid-word, which
  is why the dormant-ACP task could not append its Slice A outcome.
- **Method lessons carried from last week:** a merged landing PR does not prove the work shipped;
  grep the whole repo, not one guessed path; `wrangler.toml` does not prove a deployed value
  (the production GitHub Environment has 43 variables and overrides it); a checkbox ratio is not
  evidence either way; every delete needs per-item evidence; when unsure, keep.

## Implementation checklist

- [ ] Archive the 14 verified-shipped active files with per-item evidence and a provenance footer
- [ ] Demote `2026-09-26-trustworthy-task-status` to backlog, narrowed to the unshipped day-7 half
- [ ] Append a dated status block to `2026-09-03-projectdata-production-capacity-emergency` and keep it active
- [ ] Repair every citation of a moved `tasks/active/…` path across the repo
- [ ] Audit all 300 backlog files (10 parallel read-only reviewers, 30 files each), then verify every delete-class verdict
- [ ] Delete / consolidate / narrow backlog entries with one-line evidence each; keep anything plausibly open
- [ ] Resolve the non-standard `tasks/completed/` directory
- [ ] File the `update_idea` silent-truncation bug as a backlog entry
- [ ] Post a status nudge or park decision on every open PR older than 7 days (#1788, #1817, #2020, #2062)
- [ ] Record the full ledger here and move this file to `tasks/archive/`

## Acceptance criteria

- Every file left in `tasks/active/` has a measurably unmet acceptance criterion and live work.
- Every archived file has a footer stating how it shipped, and no box is ticked without evidence.
- Every backlog deletion/consolidation has a one-line rationale in the PR description and this ledger.
- No citation in the repo points at a task path this PR moved or deleted.
- Each open PR older than 7 days has a new comment with a concrete status or park decision.
- The arithmetic of files before/after closes exactly.

## References

- `tasks/archive/2026-09-23-weekly-queue-reconciliation.md` (last week's run and method)
- `.claude/rules/09-task-tracking.md`, `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/25-review-merge-gate.md`
