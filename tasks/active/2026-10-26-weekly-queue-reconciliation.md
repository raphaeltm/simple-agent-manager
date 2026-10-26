# Weekly queue reconciliation — 2026-10-26

**SAM task:** `01M5VCR1HMSJT85M1YDJHP235Z`
**Branch:** `sam/weekly-queue-memory-reconciliation-hp235z`
**Previous run:** `tasks/archive/2026-10-12-weekly-queue-reconciliation.md` (PR #2311). No run
happened on 2026-10-19, so this one covers two weeks.

## Problem

Merged work sits in `tasks/active/`, and `tasks/backlog/` collects entries that shipped, were
superseded, or are duplicates. This run checks both against `main` and production, so the queue
shows only work that is genuinely open. It also posts a status or park decision on every open PR
older than seven days. The SAM memory half (knowledge, ideas, policies) is done through SAM MCP
tools and summarized here, not in the diff.

## Research findings

- The brief estimated about 75 active and 260 backlog files. The tree at `a3a802caa` holds **22
  active and 245 backlog** files (archive: 1,270 top-level entries).
- All 22 active files are new since #2311. Each one names a PR that has since merged.
- Backlog delta since #2311 (`5ea191741`): 36 files added, 1 deleted
  (`2026-09-23-schedules-panel-hardcoded-poll-interval`), 3 modified. 210 + 36 − 1 = 245.
- 110 PRs merged between 2026-10-12 08:09Z and 2026-10-25 17:37Z (excluding #2311 and #2312).
  Deploy Production run 40219994438 deployed `main` HEAD `a3a802caa` successfully on 2026-10-25
  18:10Z, so all 110 are live.
- Open PRs: 13, all created before 2026-10-19, so all 13 are older than seven days.

## Method

1. Evidence base in `.tmp/recon/` (not committed): merged-PR index and digest (touched paths,
   body excerpts), successful Deploy Production runs with head SHAs, backlog batches.
2. Active files: three parallel reviewers find each file's landing PR and merge commit, the first
   successful production deploy containing it (`git merge-base --is-ancestor`), and check every
   unticked box. Boxes are ticked only with cited evidence; the rest keep the reason on the line.
3. Backlog: nine parallel reviewers in line-balanced batches. The 209 files audited on 10-12 get a
   delta audit against the 110 merges, checked against code on `main`, not PR titles. The 36 new
   files get a full audit. Verdicts: UNCHANGED, PROGRESS, SHIPPED, SUPERSEDED, DUPLICATE,
   OBSOLETE, UNSURE. When unsure, keep.
4. Remove a backlog file only on a verified delete-class verdict; archive instead of deleting when
   anything that remains links to its path.
5. Open PRs: read each one's state, checks and history, then comment a status nudge or park
   decision.

## Implementation checklist

- [ ] Audit the 22 active files; archive shipped ones with a provenance footer
- [ ] Tick stale boxes only with cited evidence; leave the rest unticked with the reason on the line
- [ ] Repoint every citation of a moved task path
- [ ] Delta-audit the 209 older backlog files; fully audit the 36 new ones
- [ ] Remove backlog files only on a verified delete-class verdict (archive + repoint when linked)
- [ ] Add a `Reconciliation 2026-10-26` block to every file with new progress or a corrected fact
- [ ] Record every finding the audit verifies (backlog notes or SAM ideas)
- [ ] Post a status nudge or park decision on each of the 13 open PRs
- [ ] Record the full ledger here, then move this file to `tasks/archive/`

## Acceptance criteria

- [ ] Every file left in `tasks/active/` is genuinely in progress, with the reason recorded
- [ ] Every removed backlog file has a one-line rationale with code evidence in the PR description
- [ ] No reference to a moved or deleted task path is left dangling
- [ ] Each open PR older than seven days has a dated status/park comment
- [ ] File-count arithmetic reconciles (before = after, allowing for the ledger and deletions)

## References

- `.claude/rules/09-task-tracking.md`, `.claude/rules/38-agent-feedback-and-memory.md`
- `tasks/archive/2026-10-12-weekly-queue-reconciliation.md` (method and conventions)
