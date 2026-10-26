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

- The brief estimated about 75 active and 260 backlog files. The tree at `a3a802caa` held **22
  active and 245 backlog** files, and 1,270 top-level `tasks/archive/` entries.
- All 22 active files were new since #2311, and each named a PR that has since merged.
- Backlog delta since #2311 (`5ea191741`): 36 files added, 1 deleted
  (`2026-09-23-schedules-panel-hardcoded-poll-interval`), 3 modified. 210 + 36 − 1 = 245.
- 110 PRs merged between 2026-10-12 08:09Z and 2026-10-25 17:37Z (not counting #2311 and #2312).
  Deploy Production run 40219994438 deployed `main` HEAD `a3a802caa` on 2026-10-25 18:10Z, so all
  110 are live.
- 13 PRs are open. All were created before 2026-10-19, so all 13 are older than seven days.

## Method

1. Built the evidence base in `.tmp/` (not committed): the 110 merged PRs with merge commits,
   touched paths and body excerpts; every successful Deploy Production run with its head SHA; the
   backlog delta; the open PRs.
2. Audited the 22 active files with three parallel read-only reviewers. For each file: the landing
   PR and merge commit, the first successful production deploy containing it
   (`git merge-base --is-ancestor`), and every unticked box. Boxes were ticked only with cited
   evidence; the rest keep the reason on the line. Each file got a provenance footer.
3. Audited all 245 backlog files with nine parallel read-only reviewers in line-balanced batches.
   The 209 older files got a delta audit against the 110 merges, checked against code on `main`,
   not PR titles; the 36 new files got a full audit. Verdicts: UNCHANGED, UNCHANGED+FIX, PROGRESS,
   SHIPPED, SUPERSEDED, DUPLICATE, OBSOLETE, UNSURE. When unsure, keep.
4. Removed a backlog file only on a delete-class verdict that I re-checked in code. SHIPPED files
   were archived with a footer; duplicates were folded into the surviving file first; links to a
   removed path were repointed or annotated.
5. Read each open PR's state, checks, history and owner task before commenting.
6. Edits to backlog files are insert-only dated blocks, except for checkbox ticks that cite
   evidence and the consolidation sections named below.

<<OUTCOME>>

## Active: 22 → 0

Every file is merged and live in production. Each got a `## Reconciliation 2026-10-26` footer.
Production-deploy runs are the first successful Deploy Production run whose head contains the merge.

| File | Shipped by | First production deploy | Boxes left unticked |
| --- | --- | --- | --- |
| `2026-10-11-dynamic-admin-settings-phase1` | #2304 `980cef76c` | 38984656469 | none |
| `2026-10-11-reap-empty-managed-vm-nodes` | #2305 `51a0acc90` | 38963983049 | none |
| `2026-10-13-same-container-secret-exec` | #2332 `faaf861ba` | 38522169513 | none |
| `2026-10-14-durable-github-trigger-recovery` | #2335 `a6866fafa` | 38559400967 | none |
| `2026-10-14-pulumi-generated-secret-annotations` | #2334 `e52a8b17a` | 38550040877 | none |
| `2026-10-15-ai-sdk-7-pr-2343` | #2343 `278e3f1ae` | 38665188578 | none |
| `2026-10-15-reliability-ab-release` | #2358 `8778abe1c`; #2363 `bde4f9821` + #2370 `d241cb05e` | 38954488477; 38979561653 | n/a (no checklist) |
| `2026-10-15-reliability-b-git-access` | #2358 `8778abe1c` | 38954488477 | none |
| `2026-10-15-reliability-c-sqlite-hot-keys` | #2371 `8394efa14` | 39044559133 | none |
| `2026-10-15-remove-platform-publication` | #2363 `bde4f9821` (source #2355) + #2370 | 38979561653 | 1: the bounded Codex VM runtime proof (fixture setup failed; the owner accepted a source audit) |
| `2026-10-16-reliability-a-r2-cors-release-blocker` | #2370 `d241cb05e` | 38979561653 | none |
| `2026-10-16-reliability-c-production-release` | #2371 `8394efa14` | 39044559133 (attempt 2) | 2: production boot-log, rollback and old-writer proofs, dropped as gates by Raphaël on 2026-10-17 |
| `2026-10-18-admin-recovery-binding-collision` | #2377 `f483db374` | 39178996406 | none |
| `2026-10-18-ci-wait-guidance` | #2374 `5b79e6c12` | 39116488528 | none |
| `2026-10-18-explicit-pr-ownership` | #2378 `0e603a055` | 39186042249 | none |
| `2026-10-21-align-tanstack-query` | #2396 `c0fb8edd8` | 39534453374 | none |
| `2026-10-21-durable-workflow-foundation` | #2404 `2585626df` | 39691992669 | none |
| `2026-10-21-workflow-event-waits` | #2406 `e063961fb` | 39725139516 (head `1b99904ce`; the merge commit's main CI hit a flake fixed by #2407) | none |
| `2026-10-23-deployments-ui-redesign` | #2426 `833ebc366` | 40079745357 | none |
| `2026-10-23-idea-updates-timeline` | #2427 `a3404a848` | 40053282069 | none |
| `2026-10-23-t8-ideas-redesign-derived-status` | #2436 `e19aa30c1` + #2439 `d41ff95d6` | 40104056792; 40120468463 | 1, moot: the conditional backfill (both counts were 0) |
| `2026-10-24-agent-linked-context` | #2435 `45c7490fd` | 40092539612 | none |

Notes behind the table:

- **Ticks.** 66 stale boxes were ticked across 18 files, each citing a run, commit, `file:line`,
  test, or a PR comment or body section that records the check. The dynamic-admin-settings release
  box is ticked on the basic production smoke (health, unauthenticated 401): since Raphaël's
  2026-10-17 16:50 UTC rule, production gets basic smoke only.
- **One false tick corrected.** The T8 file ticked an Updates item that includes "derived lifecycle
  entries". Those never shipped: `IdeaUpdates` renders authored notes only
  (`apps/web/src/pages/ideas/idea-activity.tsx:150-157`). The file now says so under the item.
- **Reliability C is activated.** The activation record was published by run 39047889679 and
  cutover happened on 2026-10-17 at 16:15 UTC. `tasks/evidence/2026-10-17-reliability-c/release.md`
  still said production was pending, so it got a dated pointer to the final record.
- **Platform autosave is gone.** No "Auto-committed by SAM on agent completion" commit exists on
  any of the 2,083 remote refs after 2026-10-16 21:18Z.
- **Repointed:** `apps/api/tests/workers/empty-node-warm-handoff.test.ts:2` (comment only). Two
  code comments already cited the `tasks/archive/` path and now resolve.

<<OPENPRS>>

<<FINDINGS>>

<<BACKLOG>>

<<MEMORY>>

<<TOP10>>

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
