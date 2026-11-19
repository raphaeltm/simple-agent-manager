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

## Outcome

| Directory        | Before |     After |
| ---------------- | -----: | --------: |
| `tasks/active/`  |     22 |     **0** |
| `tasks/backlog/` |    245 |   **239** |
| `tasks/archive/` |  1,270 | **1,295** |

Before: 22 + 245 + 1,270 = 1,537. After: 0 + 239 + 1,295 = 1,534.

- Active: 22 → 0. All 22 moved to archive.
- Backlog: 245 → 239. Two moved to archive and four were deleted (two duplicates folded into an older
  file, one superseded, one obsolete).
- Archive: 1,270 → 1,295. It gained the 22 from active, the 2 from backlog, and this ledger.
- Total: down 3, because four deletions outweigh the new ledger.

## Active: 22 → 0

Every file is merged and live in production. Each got a `## Reconciliation 2026-10-26` footer.
Production-deploy runs are the first successful Deploy Production run whose head contains the merge.

| File                                               | Shipped by                                               | First production deploy                                                               | Boxes left unticked                                                                               |
| -------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `2026-10-11-dynamic-admin-settings-phase1`         | #2304 `980cef76c`                                        | 38984656469                                                                           | none                                                                                              |
| `2026-10-11-reap-empty-managed-vm-nodes`           | #2305 `51a0acc90`                                        | 38963983049                                                                           | none                                                                                              |
| `2026-10-13-same-container-secret-exec`            | #2332 `faaf861ba`                                        | 38522169513                                                                           | none                                                                                              |
| `2026-10-14-durable-github-trigger-recovery`       | #2335 `a6866fafa`                                        | 38559400967                                                                           | none                                                                                              |
| `2026-10-14-pulumi-generated-secret-annotations`   | #2334 `e52a8b17a`                                        | 38550040877                                                                           | none                                                                                              |
| `2026-10-15-ai-sdk-7-pr-2343`                      | #2343 `278e3f1ae`                                        | 38665188578                                                                           | none                                                                                              |
| `2026-10-15-reliability-ab-release`                | #2358 `8778abe1c`; #2363 `bde4f9821` + #2370 `d241cb05e` | 38954488477; 38979561653                                                              | n/a (no checklist)                                                                                |
| `2026-10-15-reliability-b-git-access`              | #2358 `8778abe1c`                                        | 38954488477                                                                           | none                                                                                              |
| `2026-10-15-reliability-c-sqlite-hot-keys`         | #2371 `8394efa14`                                        | 39044559133                                                                           | none                                                                                              |
| `2026-10-15-remove-platform-publication`           | #2363 `bde4f9821` (source #2355) + #2370                 | 38979561653                                                                           | 1: the bounded Codex VM runtime proof (fixture setup failed; the owner accepted a source audit)   |
| `2026-10-16-reliability-a-r2-cors-release-blocker` | #2370 `d241cb05e`                                        | 38979561653                                                                           | none                                                                                              |
| `2026-10-16-reliability-c-production-release`      | #2371 `8394efa14`                                        | 39044559133 (attempt 2)                                                               | 2: production boot-log, rollback and old-writer proofs, dropped as gates by Raphaël on 2026-10-17 |
| `2026-10-18-admin-recovery-binding-collision`      | #2377 `f483db374`                                        | 39178996406                                                                           | none                                                                                              |
| `2026-10-18-ci-wait-guidance`                      | #2374 `5b79e6c12`                                        | 39116488528                                                                           | none                                                                                              |
| `2026-10-18-explicit-pr-ownership`                 | #2378 `0e603a055`                                        | 39186042249                                                                           | none                                                                                              |
| `2026-10-21-align-tanstack-query`                  | #2396 `c0fb8edd8`                                        | 39534453374                                                                           | none                                                                                              |
| `2026-10-21-durable-workflow-foundation`           | #2404 `2585626df`                                        | 39691992669                                                                           | none                                                                                              |
| `2026-10-21-workflow-event-waits`                  | #2406 `e063961fb`                                        | 39725139516 (head `1b99904ce`; the merge commit's main CI hit a flake fixed by #2407) | none                                                                                              |
| `2026-10-23-deployments-ui-redesign`               | #2426 `833ebc366`                                        | 40079745357                                                                           | none                                                                                              |
| `2026-10-23-idea-updates-timeline`                 | #2427 `a3404a848`                                        | 40053282069                                                                           | none                                                                                              |
| `2026-10-23-t8-ideas-redesign-derived-status`      | #2436 `e19aa30c1` + #2439 `d41ff95d6`                    | 40104056792; 40120468463                                                              | 1, moot: the conditional backfill (both counts were 0)                                            |
| `2026-10-24-agent-linked-context`                  | #2435 `45c7490fd`                                        | 40092539612                                                                           | none                                                                                              |

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

## Open PRs older than seven days

All 13 open PRs are older than seven days. Each got a dated comment on 2026-10-26 with what changed
and the decision that ends the park. Behind = commits on `main` not on the PR branch.

| PR                                        |  Age | Behind | Comment                                                                                           | Recommendation                                                        |
| ----------------------------------------- | ---: | -----: | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| #1788 scheduled OSV scan                  | 77 d |  1,216 | [6409898026](https://github.com/raphaeltm/simple-agent-manager/pull/1788#issuecomment-6409898026) | Close, keep as an Idea (unchanged since 10-05)                        |
| #1817 architecture workspace prototype    | 74 d |  1,204 | [6409898732](https://github.com/raphaeltm/simple-agent-manager/pull/1817#issuecomment-6409898732) | Close, keep as an Idea (unchanged since 10-05)                        |
| #2062 sleep-progress moon asset           | 45 d |    700 | [6409899508](https://github.com/raphaeltm/simple-agent-manager/pull/2062#issuecomment-6409899508) | Keep parked until the product call                                    |
| #2265 SonarCloud coverage ingestion       | 18 d |    369 | [6409900140](https://github.com/raphaeltm/simple-agent-manager/pull/2265#issuecomment-6409900140) | Add a least-privilege analysis token, or close                        |
| #2308 owner WIP download (draft only)     | 15 d |    338 | [6409900912](https://github.com/raphaeltm/simple-agent-manager/pull/2308#issuecomment-6409900912) | Decide if owners should download saved work; else close               |
| #2351 coordinator autosave artifact       | 11 d |    201 | [6409901749](https://github.com/raphaeltm/simple-agent-manager/pull/2351#issuecomment-6409901749) | Close: its own close condition is met                                 |
| #2352 Reliability B original draft        | 11 d |    192 | [6409902391](https://github.com/raphaeltm/simple-agent-manager/pull/2352#issuecomment-6409902391) | Close: superseded by #2358                                            |
| #2354 Reliability A original draft        | 11 d |    197 | [6409902999](https://github.com/raphaeltm/simple-agent-manager/pull/2354#issuecomment-6409902999) | Close: superseded by #2355/#2363                                      |
| #2357 Reliability C original draft        | 11 d |    201 | [6409903694](https://github.com/raphaeltm/simple-agent-manager/pull/2357#issuecomment-6409903694) | Close: superseded by #2371                                            |
| #2361 Reliability A/B/C integration draft | 11 d |    184 | [6409904280](https://github.com/raphaeltm/simple-agent-manager/pull/2361#issuecomment-6409904280) | Close; re-cut the speech refactor if wanted                           |
| #2366 autosave of `.do-state.md`          | 10 d |    195 | [6409904871](https://github.com/raphaeltm/simple-agent-manager/pull/2366#issuecomment-6409904871) | Close without merging                                                 |
| #2367 autosave of B release evidence      | 10 d |    188 | [6409905401](https://github.com/raphaeltm/simple-agent-manager/pull/2367#issuecomment-6409905401) | Close without merging                                                 |
| #2376 apex marketing redirect             |  8 d |     78 | [6409905991](https://github.com/raphaeltm/simple-agent-manager/pull/2376#issuecomment-6409905991) | Grant the redirect permission, or close and fix plain HTTP separately |

Context:

- The seven reliability-wave PRs (#2351-#2367) are artifacts: every piece of that wave shipped
  through clean PRs (#2358, #2363 + #2370, #2371) and has been in production since 2026-10-17.
  Explicit holds recorded by earlier coordinators keep agents from closing them, so the PR Shepherd
  re-records all 13 holds four times a day (runs #203-#209 since 10-24, zero actions).
- None of the reliability PRs carries work that `main` needs, except optional leftovers named in
  the comments: #2354's `scripts/e2e/reliability-a` harness and #2361's speech refactor
  `6f6dcf1da`.
- Last run's #2310 (autosave-only PR) and #2306 (blog) are gone: #2306 merged on 10-12 and #2310 is
  closed.

## Found during the audit

Verified in code or in read-only production and GitHub state. Security-sensitive details stay in
the SAM ideas named here; this repository is public.

- **A hardening fix Raphaël asked for on 10-25 has stalled.** SAM task
  `01M5SS6QGTK40QVQT1HBZ00EY5` ran on an OpenAI Codex profile, and the provider refused the prompt as
  a possible cybersecurity risk. It has been asleep since 2026-10-25 16:36Z with no branch progress.
  It needs a re-dispatch on a Claude profile (SAM idea `01M5R2BTGXBWVN8D51CT9GM7HD`).
- **Stopping a deployment environment leaves its app-route DNS records behind.** Filed 10-25 as SAM
  idea `01M5T6S34QWSHWAGC4JVM8TJXV` (priority 7). It needs a code fix, plus an operator-approved
  cleanup of the records that already exist.
- **Deployment nodes stuck in `destroying` are never retried.** Every node-cleanup sweep filters
  `node_role = 'workspace'`, and nodes created before credential fingerprints cannot prove ownership
  for strict teardown. Three ghost rows sit on the Infrastructure page (diagnosis task
  `01M5T5C55B34FS4WW3P285E4FD`; idea `01M211FBNN6J77DMT9KY076VEX`).
- **The T8 idea-page fixes are stranded on an unmerged branch.** `sam/t8-pr2-review-followups`
  (`e15594807`, 4 commits on `d41ff95d6`) fixes two HIGH findings from the post-merge review of #2439:
  the "derived lifecycle entries" never shipped, and the page polls a roughly 9-round-trip read every
  30 s (`apps/web/src/lib/query-options/ideas.ts:43,55`), over the read budget of 8. No PR was
  opened, and both owners have been asleep since 10-24.
- **Recovery-failure cleanup can strand a replacement workspace at `creating`.** When a stopped
  session cannot be re-slept, `resleepRecoverySession` throws
  (`apps/api/src/durable-objects/task-runner/recovery-failure-cleanup.ts:52`) before the binding
  release (`:109`), the `beforeRelease` cleanup (`:138`) and `failSessionSnapshotRecovery` (`:143`).
  Seen in production on 10-19 after #2377; owner task `01M52PEXV56VPD7H8541HP8EFJ` is still asleep
  with a D1 unique-constraint error on `workspaces.chat_session_id`.
- **The bare marketing domain is only half fixed.** `https://simple-agent-manager.org/` now answers
  301 to `www`, from outside #2376. Plain `http://simple-agent-manager.org/` still returns 522
  after about 19 s, and `http://www.simple-agent-manager.org/` redirects to the `sam-www.pages.dev`
  host. Recorded on #2376.
- **The completed 2026-09-04 ProjectData relief plan is still armed in production** (unchanged since
  10-12): 31 production Environment variables, with `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED`
  and `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` both `true`. Disarming it is an operator action.
- **The PR Shepherd spends four runs a day re-recording 13 holds.** Runs #203-#209 since 10-24
  inspected every PR and changed nothing; 9 of the 13 are superseded artifacts.
- **Process slips in the linked-work wave.** #2439 merged before three of the coordinator's required
  reviews ran (they ran afterwards). #2436's CodeRabbit findings were fixed (`4a66babfb`) but the
  threads were never resolved. The explicit-PR-ownership work deferred a SonarCloud S3776 finding
  with CRITICAL scanner severity to idea `01M58VZPD9VS1SZQQ2DMHGZ5WZ` without the coordinator's
  approval.
- **Smaller findings, recorded on their backlog files:**
  - `list_ideas` in the SAM assistant and project-agent tools still selects ideas by status, so after
    #2436 it returns undispatched draft tasks as ideas (`2026-04-27-sam-tools-post-review-improvements`).
  - Nine more ProjectData list reads fail whole on one bad row (`2026-07-16-project-data-row-fault-isolation-audit`).
  - An Instant acceptance failure can leave a node row at `creating` forever (`2026-10-24-instant-acceptance-failure-leaves-creating-rows`).
  - A teammate's root file listing shows the repository folder inside itself (`2026-10-20-file-list-shows-folder-inside-itself`).
  - The UI Compliance CI check still reports "No UI file changes detected" on UI PRs (`2026-10-23-ui-compliance-check-never-sees-ui-changes`).
  - The dark usage screenshots are byte-identical to the light ones and also appear on the compute-pools page (`2026-10-15-recapture-dark-usage-screenshots`).
  - Dead state after #2363: `gitPushResult` and `WorkspaceRuntime.DefaultBranch` (`2026-03-03-simplify-vm-agent-architecture`).
  - Three unconfirmed new test flakes (`2026-07-04-fix-flaky-tests-at-root`).
- **Cost:** the daily monitor classified 2026-10-24 as a spike ($43.69/month projected, mostly DO SQLite
  writes) on a day with about three times the usual agent activity; 2026-10-25 was back to normal
  ($9.80/month). The monitor still needs a local dependency restore before it can run, and 6 of the
  30 days before 10-24 have no valid data.

## Backlog: 245 → 239

### Verdict tally (245 files audited)

| Verdict                                    | Files | Action                                                                    |
| ------------------------------------------ | ----: | ------------------------------------------------------------------------- |
| UNCHANGED                                  |    92 | Kept, no edit                                                             |
| UNCHANGED with a corrected fact or pointer |   119 | Kept, dated `Reconciliation 2026-10-26` note                              |
| PROGRESS                                   |    24 | Kept, `Reconciliation 2026-10-26` note with what shipped and what is left |
| UNSURE                                     |     4 | Kept                                                                      |
| SHIPPED                                    |     2 | Archived with a provenance footer                                         |
| DUPLICATE                                  |     2 | Folded into the older file, then deleted                                  |
| SUPERSEDED                                 |     1 | Deleted                                                                   |
| OBSOLETE                                   |     1 | Deleted                                                                   |

Notes are insert-only: one dated block under the title, above any older block. No body text was
rewritten. Exceptions, each named here: two boxes ticked with evidence in
`2026-10-16-production-do-cost-spike`, and the consolidation section added to
`2026-09-08-ended-chat-requests-deleted-workspace`.

Many corrections fix pointers that were already stale on 10-12 but were recorded as UNCHANGED then
(for example `template.ts:236-237`, `ci.yml:364`, `schema.ts:283-334`, a `buildAgentCommand()` that
never existed). This run counted a pointer as stale when it now lands on unrelated code; drift of
three lines or less inside the same construct was left alone.

### Removed (6), one line each

- `2026-10-15-chat-attachment-delivery` (shipped, **archived**): #2359 (`0b0dd3ce3`) shipped the
  attachment queue (`useAttachments.ts:93-139`), paste and drop, transfer after wake
  (`prompt-attachments.ts:26`) and retry instead of drop (`vm-prompt-delivery-adapter.ts:165-177`),
  with tests; first production deploy run 38773686265.
- `2026-10-20-sam-mastra-modernization` (shipped, **archived**): #2386 (`f61e07d2a`), production run
  39527578978 and minimal smoke. The roadmap and debt stay in ideas `01KQ720TE8Y8ZGVTZPBM8Y4NH0` and
  `01M5CRNJAHDKYTEHFG2G8DD8T1`. The evidence citation in `tasks/evidence/2026-10-20-sam-modernization/`
  is repointed.
- `2026-10-19-chat-page-workspace-404-retries` (duplicate, **deleted**): the same
  `useSessionInfrastructure` 404 retry as `2026-09-08-ended-chat-requests-deleted-workspace`. Its
  repro and acceptance criteria were carried into that file first; the archived mention in
  `2026-10-19-shared-sessions-and-comments` is annotated.
- `2026-10-24-chat-retries-deleted-workspace` (duplicate, **deleted**): the third copy of the same
  bug; its 10-24 repro was carried over; the archived mention in `2026-10-23-comment-context-reader`
  is annotated.
- `2026-03-17-dispatch-push-parent-branch` (superseded, **deleted**): its remaining scope was a
  platform-side push before dispatch. #2363 removed platform Git publication ("SAM does not publish
  changes automatically", `configuration.md:429`), and the push-it-yourself path meets all three
  criteria (`tool-definitions-task-tools.ts:200`, `dispatch-tool.ts:385-388`,
  `services/workspace-branch.ts:73`). Only the weekly ledgers named it.
- `2026-08-04-auto-commit-push-guard-false-positive-manual-workspaces` (obsolete, **deleted**): the
  push guard it targets was deleted with the publication path (`99c8ca22a`, via #2363);
  `git grep shouldBlockDefaultBranchPush` finds nothing. Only the weekly ledgers named it.

### Progress since 2026-10-12, note added (24)

- `2026-03-03-simplify-durable-objects-and-schema`: #2443 added `idx_tasks_parent_task_id` (migration 0208); the nodes indexes are still missing.
- `2026-03-03-simplify-vm-agent-architecture`: #2363 deleted the platform push/PR code, so the `workspacegit` extraction is moot; dead `gitPushResult` and `DefaultBranch` state remain.
- `2026-03-03-task-completion-lifecycle`: #2428 records `pull_request` and check webhooks, including merged state; nothing auto-completes a task on merge yet.
- `2026-03-04-system-reliability-and-maintainability-hardening`: #2304 added the typed admin settings registry and the runtime-tunables ratchet; `Env` is still 1,584 lines.
- `2026-03-19-graph-execution-model`: #2404/#2405 added workflow-run DAGs and a graph view; mission budgets, plan approval and ad-hoc mission graphs remain.
- `2026-03-28-file-raw-security-hardening`: #2383 added realpath confinement for teammate reads only; size and MIME checks remain.
- `2026-04-18-multi-level-override-framework`: #2414 resolves callable models skill → profile → project → defaults; #2399 made `skills.agent_type` nullable; phases 3-6 and 8 remain.
- `2026-04-18-project-credentials-followups`: #2414 split out `ProjectSettingsAgentsTab.tsx` (Finding 2); the missing `opencodeProvider` (Finding 1) remains.
- `2026-04-27-sam-tools-post-review-improvements`: #2436 moved `find_related_ideas` to `is_idea = 1`; `list_ideas` still filters by status and now returns undispatched draft tasks as ideas.
- `2026-05-11-duplicate-task-session-finalization`: #2302 writes `chat_session_id` in every mission-task INSERT; the orchestrator's own dispatch still creates the session before the claim.
- `2026-07-04-fix-flaky-tests-at-root`: #2407 fixed a new case of the 1 s `findBy` class that failed `main` CI; three unconfirmed new candidates are listed.
- `2026-07-16-project-data-row-fault-isolation-audit`: #2443 isolated attention markers per row and #2435 removed two reads; nine more bare `parseRow` maps were added to the list.
- `2026-07-17-stale-playwright-audit-specs`: #2348 repaired `landing-audit` and five other quarantined specs were deleted with their pages; now 91 of 134 quarantined (was 98 of 124).
- `2026-07-19-repo-history-bloat-cleanup`: #2363 removed the autosave path; the history-rewrite decision and the blob-size guard remain.
- `2026-08-07-expand-frontend-query-cache-and-persistence`: #2426 and #2389 moved Deployments and the trigger page to TanStack Query; seven pages and the admin pages remain.
- `2026-08-07-fix-stuck-task-sweep-pattern-complexity`: #2317 replaced the dedupe LIKE with `instr()` plus a real-D1 test (last run's #2); the 50-byte guard and production confirmation remain.
- `2026-08-11-clipped-overflow-debt-sweep`: #2426 cleared one row and #2389 deleted `triggers-ui-audit`; the guard is still advisory, 10 offenders stay quarantined.
- `2026-08-18-consolidate-hand-rolled-visibility-polls`: #2426 moved both deployment polls to TanStack `refetchInterval`; #2398 added a new hand-rolled listener.
- `2026-09-09-node-idle-timeout-project-setting-has-no-consumer`: #2360 removed the dead UI control; the API and types still carry the field.
- `2026-09-19-volume-status-badge-and-create-time-status`: #2426 deleted the volumes panel, so item 1 is moot; item 2 remains.
- `2026-09-23-playwright-audit-shell-mocks-crash`: #2439 added opt-in shell-mock helpers; the `{}` fallback remains.
- `2026-09-30-update-idea-append-silently-truncated-at-cap`: #2427 added idea notes outside the capped text; truncation is still silent.
- `2026-10-16-production-do-cost-spike`: #2368 shipped the fix (production reads −92.6%); two delivery boxes ticked; the deferred `nextSequence` index and DO-usage alert remain.
- `2026-10-24-cap-linked-chats-per-idea`: #2436 already caps links per idea (default 50, disclosed as "50+"); ranking and two tests remain.

### Unsure, kept (4)

- `2026-02-23-suppress-background-subagents-in-acp`: unsure since 09-30; only a live repro can show whether #1845 made it moot.
- `2026-07-14-stabilize-codex-crash-recovery-reporting-tests`: no Go failure in the last 100 failed CI runs, which does not prove the tests deterministic.
- `2026-10-02-rebuild-grouped-fts-after-wall-recovery`: unchanged since 10-12; a rule-42 code comment (`grouped-fts-wall-recovery.ts:31`) still points here.
- `2026-10-04-instant-generation-aware-callback-token-renewal`: renewal still refuses Instant; closing it is Raphaël's call.

Closure candidate for Raphaël: `2026-09-26-trustworthy-task-status` meets every acceptance criterion in
code; the only open box is a staging check for #2153, which has been in production for a month.

### Corrected or extended, note added (119)

Each file's dated note has the detail.

- `2026-02-15-vm-agent-in-place-binary-update`
- `2026-02-16-additional-cloud-providers`
- `2026-02-16-sidebar-redesign-tier2`
- `2026-02-17-vm-log-browser`
- `2026-02-20-acp-session-error-observability`
- `2026-02-20-agent-session-startup-optimization`
- `2026-02-20-orphaned-session-detection-and-recovery`
- `2026-02-23-worktree-redesign`
- `2026-02-24-vm-agent-process-lifecycle-and-stability`
- `2026-02-27-tdf-1-task-state-machine`
- `2026-03-03-improve-test-infrastructure`
- `2026-03-03-simplify-deploy-scripts-and-infra`
- `2026-03-03-simplify-shared-packages`
- `2026-03-03-simplify-web-app-components`
- `2026-03-07-research-chat-truncation-causes`
- `2026-03-09-fix-task-status-display`
- `2026-03-09-llm-task-prioritization`
- `2026-03-12-bootstrap-token-dual-auth-dead-code`
- `2026-03-13-binary-install-security-hardening`
- `2026-03-13-wire-provider-env-var-overrides`
- `2026-03-14-fork-dialog-ui-polish`
- `2026-03-14-unified-session-task-workspace-state-machine`
- `2026-03-15-agent-profiles-4-system-prompt-injection`
- `2026-03-16-compute-lifecycle-test-gaps`
- `2026-03-16-mcp-page-size-limits-not-configurable`
- `2026-03-16-notification-phase2-perf-followups`
- `2026-03-16-notification-security-followups`
- `2026-03-16-notification-test-coverage-gaps`
- `2026-03-16-notification-ui-accessibility-followups`
- `2026-03-16-port-exposure-security-hardening`
- `2026-03-17-acp-subagent-idle-detection`
- `2026-03-17-mcp-token-do-storage-security`
- `2026-03-18-fix-git-identity-conversation-mode`
- `2026-03-18-gcp-self-hosting-docs`
- `2026-03-18-workspace-mcp-server-p2`
- `2026-03-19-mcp-notification-waituntil`
- `2026-03-28-migrate-file-proxy-token-to-auth-header`
- `2026-03-30-enforce-per-project-task-execution-timeout`
- `2026-04-01-replace-source-contract-tests`
- `2026-04-03-split-oversized-files`
- `2026-04-09-document-heartbeat-acp-sweep`
- `2026-04-09-trigger-api-optimizations`
- `2026-04-10-git-show-colon-refspec-injection`
- `2026-04-10-route-level-error-message-leakage`
- `2026-04-10-web-lazy-loading-error-boundaries-a11y`
- `2026-04-13-knowledge-graph-hardening`
- `2026-04-13-knowledge-graph-test-coverage`
- `2026-04-18-project-credentials-missing-tests`
- `2026-04-19-trial-late-audit-hardening`
- `2026-04-19-trial-sse-abort-propagation`
- `2026-04-19-trial-sse-cursor-persistence`
- `2026-04-20-platform-trial-enabled-env-var`
- `2026-04-22-infrastructure-nav-and-platform-infra-admin`
- `2026-04-23-deploy-script-security-hardening`
- `2026-04-23-remove-docker-requires-from-vm-agent-systemd`
- `2026-04-24-library-like-escape-clause`
- `2026-04-24-session-header-a11y-token-fixes`
- `2026-04-30-unified-user-usage-stats`
- `2026-05-01-ai-proxy-credential-hardening`
- `2026-05-01-fix-playwright-desktop-test-infrastructure`
- `2026-05-19-error-banner-role-alert`
- `2026-05-20-amp-project-chat-mcp-wiring`
- `2026-06-06-library-ui-a11y-preexisting`
- `2026-06-07-leak-sweep-test-coverage-gaps`
- `2026-06-07-theme-switcher-playwright-coverage-gaps`
- `2026-06-08-same-org-submodule-repo-access`
- `2026-06-09-git-credential-node-token-fallback-hardening`
- `2026-06-12-timeline-drawer-post-merge-fixes`
- `2026-06-15-alternative-inference-providers-backend`
- `2026-06-18-api-composition-root-extraction`
- `2026-06-18-deploy-day2-ops-followups`
- `2026-06-18-vm-agent-lifecycle-idempotent-shutdown`
- `2026-06-24-compose-publish-x-sam-routes`
- `2026-07-12-cf-container-wake-restore-hardening`
- `2026-07-12-multi-installation-cloudflare-namespaces`
- `2026-07-19-instant-launch-stuck-queued-on-disconnect`
- `2026-07-19-instant-session-capacity-controls`
- `2026-07-19-split-env-interface`
- `2026-07-20-instant-ping-container-died-midsession`
- `2026-07-21-extend-stale-instant-callback-guard-coverage`
- `2026-07-21-project-invite-role-and-link-gaps`
- `2026-07-23-byo-phase0-review-followups`
- `2026-07-23-credential-routes-preexisting-hardening`
- `2026-08-03-durable-follow-up-prompt-delivery`
- `2026-08-04-instant-persistence-step-renders-as-provisioning-vm`
- `2026-08-04-report-issue-length-env-vars-cannot-raise-limits`
- `2026-08-04-shared-staging-do-migration-pinning`
- `2026-08-04-sleeping-status-renders-as-unknown`
- `2026-08-06-digitalocean-vultr-pagination-silent-truncation`
- `2026-08-06-harden-vm-incident-callback-lifecycle-binding`
- `2026-08-06-isolate-standalone-agent-process-environment`
- `2026-08-06-project-orchestrator-cancel-status-events`
- `2026-08-06-reconciliation-dead-target-task-status-events`
- `2026-08-06-run-gate-ignores-platform-cloud-credential`
- `2026-08-07-durable-background-vm-provisioning`
- `2026-08-07-pre-destroy-safe-evidence-capture`
- `2026-08-08-debugging-overhaul-review-followups`
- `2026-08-11-migrate-remaining-source-contract-ui-tests`
- `2026-08-11-project-agent-short-conversation-duplicate-message`
- `2026-08-11-trigger-paused-reason-signal`
- `2026-08-11-vm-agent-snapshot-degradation-union-mismatch`
- `2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end`
- `2026-08-18-chat-agent-state-single-do-rpc`
- `2026-08-23-get-instructions-missing-observation-ids`
- `2026-08-23-knowledge-injection-followups`
- `2026-09-08-ended-chat-requests-deleted-workspace`
- `2026-09-08-staging-capacity-query-and-deploy-reset-noise`
- `2026-09-09-chat-requests-reaped-task-404`
- `2026-09-12-split-project-data-archive-sharding-module`
- `2026-09-23-resource-sparkline-gap-marker-has-no-colour`
- `2026-09-25-split-permanent-session-recovery-refusals`
- `2026-09-26-trustworthy-task-status`
- `2026-10-15-recapture-dark-usage-screenshots`
- `2026-10-20-file-list-shows-folder-inside-itself`
- `2026-10-21-centralize-agent-and-effort-display-labels`
- `2026-10-24-codspeed-parsecompose-noise-and-stale-baseline`
- `2026-10-24-instant-acceptance-failure-leaves-creating-rows`
- `2026-10-24-regenerate-ideas-feature-screenshot`
- `2026-10-24-typecheck-test-files`

### Unchanged, no edit needed (92)

No merge since 10-12 touched their open scope, and their pointers still resolve.

- `2026-02-17-persistent-terminal-sessions`
- `2026-02-20-acp-reconnect-replay-integration-test`
- `2026-02-28-mobile-nav-dropdown-menus`
- `2026-03-10-log-viewer-test-coverage-gaps`
- `2026-03-13-scaleway-provider-improvements`
- `2026-03-18-code-context-for-task-submission`
- `2026-03-19-chat-view-transitions`
- `2026-03-19-virtual-scrolling-test-coverage-gaps`
- `2026-03-24-deployment-settings-ui-fixes`
- `2026-03-30-account-map-db-indexes`
- `2026-04-08-credential-helper-per-workspace-directory`
- `2026-04-12-credential-validity-quota-bypass`
- `2026-04-12-devcontainer-config-secondary-paths`
- `2026-04-18-agent-key-card-accessibility`
- `2026-04-18-credentials-miniflare-integration-tests`
- `2026-04-18-project-credentials-playwright-audit`
- `2026-04-19-trial-orchestrator-boot-test-coverage-gaps`
- `2026-04-19-trial-orchestrator-step-handler-coverage`
- `2026-04-26-durable-interrupts-test-gaps`
- `2026-05-01-wp6-openai-routing-integration-test`
- `2026-05-01-wp6-playwright-visual-audit`
- `2026-05-03-harness-phase1-capable-coding-agent`
- `2026-05-03-harness-phase2-sam-platform-integration`
- `2026-05-06-compact-mode-test-coverage-gaps`
- `2026-05-10-lifecycle-state-accuracy`
- `2026-05-26-encrypted-swap-cloud-init`
- `2026-06-03-tts-phase-benchmark`
- `2026-06-04-error-node-cleanup`
- `2026-06-06-projectlibrary-rule18-split`
- `2026-06-09-git-credential-loopback-container-binding`
- `2026-06-11-compose-parser-test-coverage`
- `2026-06-12-deployment-provisioning-route-tests`
- `2026-06-17-deploy-engine-security-hardening-followups`
- `2026-06-18-vm-agent-bootstrap-pipeline`
- `2026-06-20-agent-crash-loop-kitty-keyboard-escape`
- `2026-06-26-admin-user-resource-overview`
- `2026-07-12-gitlab-token-lock-rate-limit`
- `2026-07-16-observability-mcp-outcome-parsing-gap`
- `2026-07-21-instant-container-request-timeout-cancellation`
- `2026-07-21-remove-sandbox-env-fallbacks-from-container-runtime`
- `2026-07-23-vultr-onboarding-wizard-parity`
- `2026-07-25-admin-ai-proxy-orphaned-default-model`
- `2026-07-25-translate-proxy-sampling-params-4-7-plus`
- `2026-08-04-flaky-vultr-ip-poll-error-test`
- `2026-08-06-investigate-orphaned-projectdata-alarm-wall-time`
- `2026-08-06-wrangler-sync-env-parity-test-coverage-gap`
- `2026-08-09-staging-session-task-reconciliation-repair-failures`
- `2026-08-18-cf-container-single-gate-harness-race`
- `2026-08-18-project-data-id-name-identity-source`
- `2026-08-23-policy-row-retention-bound`
- `2026-09-08-agent-version-metadata-not-published`
- `2026-09-08-staging-repeated-noop-storage-alarms`
- `2026-09-09-docs-site-table-cells-overflow-on-mobile`
- `2026-09-09-scheduler-explorer-slot-count-model`
- `2026-09-11-bookmark-anchored-d1-reads`
- `2026-09-14-www-scrollable-table-wrappers-not-keyboard-focusable`
- `2026-09-25-composable-capacity-source-anchor-guard`
- `2026-09-25-reporter-session-switch-unsent-rows`
- `2026-09-25-staging-allocation-plan-no-longer-current`
- `2026-09-25-structured-log-error-text-redaction`
- `2026-09-27-chat-switch-list-first-paint`
- `2026-09-27-workspace-chat-view-transcript-cache`
- `2026-09-28-workspace-page-chat-stop-sends-chat-session-id`
- `2026-09-29-flaky-harness-activity-coalesce-test`
- `2026-10-04-acp-client-tailwind-classes-not-generated`
- `2026-10-04-legacy-chat-user-links-invisible-light-mode`
- `2026-10-04-snapshot-relay-node-proof-in-body`
- `2026-10-04-update-after-bootstrap-workspace-token-writer`
- `2026-10-09-cc-attachment-mutations-take-45-seconds`
- `2026-10-12-snapshot-wake-authority-boundary`
- `2026-10-15-refresh-desktop-hero-capture`
- `2026-10-19-gitlab-workspace-token-project-scope`
- `2026-10-19-session-complete-respects-session-writer`
- `2026-10-19-staging-claude-sam-mode-cannot-call-deferred-mcp-tools`
- `2026-10-20-archive-leaves-sleeping-task-sleeping`
- `2026-10-20-automation-page-follow-ups`
- `2026-10-20-comment-idempotency-conflict-returns-500`
- `2026-10-20-shared-chat-terminal-and-ports-decision`
- `2026-10-21-agent-profile-blank-agent-type`
- `2026-10-21-ai-usage-totals-double-count-sam`
- `2026-10-21-composer-audit-provisioning-progress-test-fails-on-main`
- `2026-10-21-docs-expired-chat-spec-drift`
- `2026-10-21-playwright-audits-failing-or-flaky-on-main`
- `2026-10-21-sam-history-records-primes-json-replies`
- `2026-10-22-github-trigger-late-task-after-exhaustion`
- `2026-10-22-trigger-field-errors-not-announced`
- `2026-10-23-automations-ignore-instant-profile-runtime`
- `2026-10-23-credential-warning-lines-indistinguishable`
- `2026-10-23-ui-compliance-check-never-sees-ui-changes`
- `2026-10-24-capacity-pool-bind-limit-test-timeout`
- `2026-10-24-chat-comment-link-under-failure-banner-on-phones`
- `2026-10-24-chat-drawer-translucency-on-phones`

## SAM memory (Part 2, done through SAM MCP, not in this diff)

Recorded here so the next weekly run can see what changed.

- **Session review.** About 440 tasks from 2026-10-12 to 10-26 were paged; 115 human-started or
  human-quoting sessions were read, about 60 of them with Raphaël's own words. 23 user-role
  searches covered correction and frustration phrases. Coverage gaps: archive search reached only
  4-8 of 137 archived-session owners per query, his words inside ChatGPT Connector conversations
  are visible only where an agent quoted them, and /sam's own conversations were not reachable.
  - **Repeated patterns:**
    - Ship it: drafts left stranded, holds he never asked for, found issues filed as follow-ups
      instead of fixed (about 8 times, 10-15 to 10-23).
    - He names the profile for each role and expects exactly that one (about 9 times).
    - Staging skipped only with his explicit, task-scoped waiver (six waivers); never full
      production tests.
    - Agents invent caps, holds and permission prompts he then has to remove (about 6 times).
    - Plain words: the actual problem before options, no time estimates, no jargon (about 6 times).
    - Idle or orphaned compute wasting money: SAM should clean up after itself (4 times).
    - Visual proof: mock-data screenshot boards and real-run screenshots in the Library (6 times).
  - Frustration showed as "WTAF", "means fuckall to a user", "I don't understand!" and "Why?".
- **Knowledge: 19 observations updated** (each update supersedes the old text, so nothing is lost):
  - Shipped since 10-12: workflow slices (`b763db0a`), AI models (`68bf4539`), workload identity
    (`f4cef9ac`), linked work (`73b4c842`), Comments Direction A (`c1b65348`), the Automation page
    (`ffacc234`, `0778b7dd`; the second also drops a 44 px clause that contradicted User
    `ff301a56`), autosave removal (`cff2ec2d`).
  - Stale facts corrected: hand-backs recurred (`b529beac`), self-cleanup expectation with the
    10-19 and 10-25 recurrences (`90925442`), PR Shepherd running again (`7d6609e1`), token-login is
    limited per IP per hour, not per token per week (`30c6d502`, checked in `api-tokens.ts`),
    Reliability C risk tolerance kept as a general rule (`c937ad87`), presentation style widened
    (`ca1b3390`), project tracking counts (`ed781fc8`), the queue pointer (`3c2bfef2`).
  - Malformed text cleaned (stray tool markup): `0d7dfb2b`, `e1d26160`, `ae9c6287`.
- **Knowledge: 9 added.** Named profile per role (AgentProfiles `49cf2a3a`); don't invent
  constraints (AgentBehavior `bf45af41`); problem first, no estimates, no jargon (ResponseStyle
  `e5c2ad51`); no dashboard steps for integrations (AdminOperationsUX `c8450359`); agent email on
  an agents subdomain (new entity AgentEmail `0b4441bd`, because Architecture is at its
  100-observation cap); reusable components across site and app (MarketingSite `5ba8edb6`);
  deterministic cost alerts (ProductionCostInvestigation `4e9f95fa`); the 10-25 credential-leak
  rule (ProdCredentialAccess `345a41c5`); the staging-waiver pattern (ReleaseTestingPolicy
  `6f4d1d4a`).
- **Knowledge: 9 retired, 8 confirmed.** Retired: three consumed task authorizations or overrides,
  the 08-16 Codex-credits note, the autosave-PR handling rule, two finished task-scoped review asks,
  the WorkloadIdentity "planning only" note, and a duplicate of the new production-testing policy.
  Confirmed: `c0db8bc8`, `06e673a5`, `c0e60e51`, `7744b849`, `8654fa13`, `068346a3`, `5a3265df`,
  `ff301a56`.
- **Policies.** The active-policy cap (100) was full. Deactivated two task-scoped GitHub-trigger
  release policies whose work shipped on 10-13/14 (`e6923eca`, `f0601d33`, both due to expire
  10-27) and `f689e529` (Events & Schedules entry point), which his explicit 10-20 approval of the
  Automation page resolved. Added `cb81ef20`: production verification is a basic smoke, full
  user-flow tests belong on staging (his 10-17 words). Updated `59898283`: a hold counts only when
  he set it (his 10-16 words). Flagged, not changed: `d55af478` (an August workflow's profile
  choice, still marked "always").
- **Ideas: 15 completed** with merged and deployed evidence; **15 narrowed** (new title plus a
  note of what shipped and what is left), including T8 (`01M5NG712YTCNSBDWWQVR4F0A1`), kept open
  because its review fixes exist only on an unmerged branch; **4 notes** on open ideas, including
  the branch-backed #2376 apex redirect; **2 created**: the hung-turn node pin
  (`01M5VG7QCDGW77VY1N4QCDJRQK`) and the post-#2436 ideas regressions
  (`01M5VG7YRFS34G6W644EQT3CEJ`). The living queue (`01M4DR7MBDD8AAVF1XMC2XYQEX`) was at its 64 KiB
  cap; its full text was archived to library file `01M5VGHAS875FQTWASDYE4F8QF` and replaced with a
  condensed v7.
- **Not reconciled:** about 70 "Recurring platform error" ideas (they need the incident queue) and
  ideas last touched before 10-12 that no merge pointed at.

## Genuinely open for the week of 2026-10-27 (ranked)

The same ranking is the living queue, SAM idea `01M4DR7MBDD8AAVF1XMC2XYQEX` (v7). Its previous text
was at the 64 KiB cap; it is archived as SAM library file `01M5VGHAS875FQTWASDYE4F8QF`.

1. **Re-dispatch the stalled hardening task on a Claude profile.** Task `01M5SS6QGTK40QVQT1HBZ00EY5`
   was refused by its OpenAI profile (SAM idea `01M5R2BTGXBWVN8D51CT9GM7HD`, priority 10).
2. **Deployment stop leaves app-route DNS records behind.** Code fix plus an operator-approved
   cleanup (SAM idea `01M5T6S34QWSHWAGC4JVM8TJXV`).
3. **Compute that is never released.** A hung final turn pins a completed task's node (SAM idea
   `01M5VG7QCDGW77VY1N4QCDJRQK`, filed this run); deployment nodes stuck in `destroying` are never
   retried (SAM idea `01M211FBNN6J77DMT9KY076VEX`).
4. **Finish two explicit asks left half done.** The T8 idea-page fixes on
   `sam/t8-pr2-review-followups` (no PR; SAM idea `01M5NG712YTCNSBDWWQVR4F0A1`), and the 10-21 "Please
   fix the filed issues" request (task `01M5ER021WQMW1QB3ETQKMFNJ9`; only a plan commit on
   `sam/sam-docs-tools-history-prose`; backlog `2026-10-21-sam-history-records-primes-json-replies`
   and `2026-10-21-ai-usage-totals-double-count-sam`).
5. **A refused wake strands a `creating` replacement workspace** (`recovery-failure-cleanup.ts:52`;
   SAM idea `01M55GNWQNFYWSV360H2F811BC`). Close the stuck owner task `01M52PEXV56VPD7H8541HP8EFJ`.
6. **One batch of decisions for Raphaël.** Close the nine superseded or parked PRs (#2351, #2352,
   #2354, #2357, #2361, #2366, #2367, #1788, #1817); decide #2062, #2265, #2308 and #2376; disarm the
   09-04 relief plan; keep or close `2026-09-26-trustworthy-task-status` and
   `2026-10-04-instant-generation-aware-callback-token-renewal`; say whether UI-only fixes may skip
   staging by default.
7. **Ideas regressions after #2436.** Ideas done before migration 0207 are unreadable, `list_ideas`
   returns draft tasks, and notes don't move an idea in "recently updated" (SAM idea
   `01M5VG7YRFS34G6W644EQT3CEJ`, filed this run).
8. **Deploy integrity gate false positive on tiny churning tables** (1 → 0 rows reads as a 100%
   drop). It blocked #2443's first production deploy (SAM idea `01M5T541KKCR7Y9H78VCQ3K0P7`).
9. **Billing monitor blind days.** It still needs a manual dependency restore before it can run (SAM
   idea `01M4QCYXTJQTGQC4VWZFXV5TR2`).
10. **XS correctness bundle.** Silent `update_idea` truncation
    (`2026-09-30-update-idea-append-silently-truncated-at-cap`), the Connector's unguarded
    `JSON.parse` in `chatsList` (`connector-read-core.ts:145`), and nine ProjectData list reads that
    fail on one bad row (`2026-07-16-project-data-row-fault-isolation-audit`).

Observe this week, not work:

- Whether 10-24's cost spike repeats (10-25 was normal).
- Reliability C after cutover: no KV PUT 429s since 10-17.
- The wake soak (SAM idea `01M4JMYRY5909JYND1XRXMM9DC`): close it after a production count of
  revoked wakes since 10-10 17:14Z.

## Implementation checklist

- [x] Audit the 22 active files; archive shipped ones with a provenance footer (all 22, footers verified)
- [x] Tick stale boxes only with cited evidence; leave the rest unticked with the reason on the line
      (66 ticked; 4 left with reasons; one false tick corrected)
- [x] Repoint every citation of a moved task path (one test comment, one evidence file; two
      historical archive mentions annotated with the new location)
- [x] Delta-audit the 209 older backlog files; fully audit the 36 new ones (nine reviewers)
- [x] Remove backlog files only on a verified delete-class verdict (archive + repoint when linked)
      (6 removed, each re-checked in code)
- [x] Add a `Reconciliation 2026-10-26` block to every file with new progress or a corrected fact
      (143 files)
- [x] Record every finding the audit verifies (backlog notes or SAM ideas; two ideas filed)
- [x] Post a status nudge or park decision on each of the 13 open PRs (comment links above)
- [x] Record the full ledger here, then move this file to `tasks/archive/`

## Acceptance criteria

- [x] Every file left in `tasks/active/` is genuinely in progress, with the reason recorded (none
      left; only `.gitkeep`)
- [x] Every removed backlog file has a one-line rationale with code evidence in the PR description
- [x] No reference to a moved or deleted task path is left dangling (repo-wide `git grep` of all
      28 old paths; only the two annotated historical mentions remain)
- [x] Each open PR older than seven days has a dated status/park comment (13 of 13)
- [x] File-count arithmetic reconciles (before = after, allowing for the ledger and deletions):
      1,537 − 4 deleted + 1 ledger = 1,534

## References

- `.claude/rules/09-task-tracking.md`, `.claude/rules/38-agent-feedback-and-memory.md`
- `tasks/archive/2026-10-12-weekly-queue-reconciliation.md` (method and conventions)
