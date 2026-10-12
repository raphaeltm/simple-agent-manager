# Weekly queue reconciliation — 2026-10-12

**SAM task:** `01M4QB6HK8D9VE5V5KP69JT8BR`
**Branch:** `sam/weekly-queue-memory-reconciliation-9jt8br`
**Previous run:** `tasks/archive/2026-10-05-weekly-queue-reconciliation.md` (PR #2233)

## Problem

Merged work sits in `tasks/active/`, and `tasks/backlog/` collects entries that shipped, were
superseded, or are duplicates. This run checks both against `main` and production, so the queue
shows only work that is genuinely open. It also posts a status or park decision on every open PR
older than seven days.

## Research findings

- The brief estimated about 75 active and 260 backlog files. The tree at `898c18597` held **7
  active and 212 backlog** files.
- Backlog delta since #2233 (`a45ff23a4`): two files added (`2026-10-07-credential-limits-…`,
  `2026-10-09-cc-attachment-mutations-…`) and three moved to archive by the PRs that fixed them
  (`2026-03-14-summarize-endpoint-hardening` by #2287, `2026-09-25-stopping-sleep-with-failed-…`
  by #2276, `2026-10-05-sleeping-task-status-follow-ups` by #2240). One file was modified
  (`2026-09-26-trustworthy-task-status`). 213 − 3 + 2 = 212.
- 70 PRs merged between 2026-10-05 07:42Z and 2026-10-11 19:32Z. Production deployed `main` HEAD
  `898c18597` (Deploy Production run 38169330561, 2026-10-11 19:45Z), so all 70 are live.
- Open PRs older than 7 days: #1788, #1817 and #2062. Last week's #2020 was closed on 10-08 as
  superseded by #2265, and #2160 was closed on 10-08 as an obsolete experiment.

## Method

1. Built the evidence base: the 70 merged PRs with merge commits, touched paths and the first
   2,500 characters of each body; the Deploy Production run history; and last week's verdicts.
2. Audited the 7 active files by hand. For each one I found the landing PR and merge commit, and
   the first successful production deploy, checked with
   `git merge-base --is-ancestor <merge> <deploy head>`. I also read each owning SAM task (wave
   work often finished in a recovery task) and checked the production state its criteria name:
   read-only D1, the Worker script settings, and `list_triggers`.
3. Delta-audited all 212 backlog files with eight parallel read-only reviewers, in line-balanced
   batches of 10 to 43 files. Each file was checked against the code on `main`, not against PR
   titles. The two files new since 10-05 got a full audit. Verdicts: UNCHANGED, PROGRESS,
   SHIPPED, SUPERSEDED, DUPLICATE, OBSOLETE, UNSURE. The rule was "when unsure, keep".
4. Removed a file only on a verified delete-class verdict, and archived it instead of deleting it
   when anything that remains links to its path.
5. Verified every new production finding in code and in read-only production D1 before
   recording it.

## Outcome

| Directory        | Before |     After |
| ---------------- | -----: | --------: |
| `tasks/active/`  |      7 |     **0** |
| `tasks/backlog/` |    212 |   **210** |
| `tasks/archive/` |  1,222 | **1,231** |

Before: 7 + 212 + 1,222 = 1,441. After: 0 + 210 + 1,231 = 1,441.

- Active: 7 → 0. All 7 moved to archive.
- Backlog: 212 → 210. One moved to archive, one deleted.
- Archive: 1,222 → 1,231. It gained the 7 from active, the 1 from backlog, and this ledger.
- Total: unchanged, because the new ledger (+1) offsets the deleted file (−1).

## Active: 7 → 0

Six files were merged, deployed to production and checked against the production state their
criteria name. The seventh, the ProjectData emergency, has no landing PR. It is archived because
its 9.0 GB size target was met through archive sharding; the outcome of its approved relief plan
was never recorded, so its criteria stay unticked. Each archived file got a provenance footer.
Stale boxes were ticked only with cited evidence, and two stay unticked with the reason on the
line.

| File                                                        | Shipped by                                                                                           | First production deploy            | Boxes left unticked                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `2026-09-03-projectdata-production-capacity-emergency`      | No single PR. The size target was met by ordinary archive sharding, helped by #2248, #2269 and #2296 | n/a                                | All criteria: the approved relief plan's outcome was never recorded; the size target was met by archive sharding |
| `2026-10-08-session-start-phase-latency`                    | #2268 `096afcd8f`                                                                                    | run 37848333921                    | none                                                                                                             |
| `2026-10-08-workers-ci-duration-and-flakes`                 | #2271 `2a5f2e7d3`                                                                                    | run 37824431034 (head `e25b40d66`) | none                                                                                                             |
| `2026-10-11-approval-gate-activity-rpc-orchestrator-status` | #2307 `af4341f90`                                                                                    | run 38162201788                    | evidence copy into the draft PR (moot after merge)                                                               |
| `2026-10-11-pr-shepherd-active-owner-check`                 | #2301 `dd5ebce4d` + #2309 `898c18597`                                                                | runs 38164808358 and 38169330561   | staging owner-tool case (accepted gap; covered by production queries)                                            |
| `2026-10-11-worker-text-binding-headroom`                   | #2303 `73feb757d`                                                                                    | run 38159699324                    | none                                                                                                             |
| `2026-10-11-worker-text-binding-inventory`                  | #2303 (supporting evidence)                                                                          | run 38159699324                    | n/a (no checklist)                                                                                               |

Production checks made for these verdicts (all read-only):

- **ProjectData:** `sql.databaseSize` for the SAM root object is 8,752,312,320 bytes at
  2026-10-12 06:16Z (ratio 0.875, status `warning`), below the 9,000,000,000-byte target since
  2026-10-10. The archive breaker is `closed`; 866 migrations are published, 87 frozen, none
  failed, poisoned or in flight.
- **Worker bindings:** `sam-api-prod` has 150 `plain_text` + 25 `secret_text` = 175 text bindings
  (321 before #2303) on deployment `741061e7`.
- **PR Shepherd:** trigger `01KPED8FFDM34EZNNFTW672S5E` is `paused`, with the reviewed owner-check
  prompt applied (recovery task `01M4NAW5A7GP6XP14S7ZA4YFA5`, #2309 comment 6113167759).
- **Ancestry:** every merge commit above is an ancestor of the head of the cited successful Deploy
  Production run.

Slice C of the ProjectData plan (`7868bc894`, unmerged, now 311 commits behind `main`) is tracked
in SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`. The grouped-FTS rebuild stays in
`tasks/backlog/2026-10-02-rebuild-grouped-fts-after-wall-recovery.md`. Five citations of the
emergency file's old `tasks/active/` path were repointed, including
`apps/api/.claude/rules/69-emergency-config-paths-need-their-own-coverage.md`.

## Open PRs older than seven days

| PR                                     |  Age | Behind `main` | Comment                                                                                           | Decision needed                                                                                |
| -------------------------------------- | ---: | ------------: | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| #1788 scheduled OSV scan               | 63 d |           905 | [6119025875](https://github.com/raphaeltm/simple-agent-manager/pull/1788#issuecomment-6119025875) | Build the private intake, or drop scheduled OSV scanning (recommended: close, keep as an Idea) |
| #1817 architecture workspace prototype | 60 d |           893 | [6119026362](https://github.com/raphaeltm/simple-agent-manager/pull/1817#issuecomment-6119026362) | Close (recommended, keep as an Idea) or re-cut as slices                                       |
| #2062 sleep-progress moon asset        | 31 d |           389 | [6119026916](https://github.com/raphaeltm/simple-agent-manager/pull/2062#issuecomment-6119026916) | Whether to show an animated moon for sleep progress, and where                                 |

Last week's #2020 was closed on 2026-10-08 as superseded by #2265, which is 4 days old and parked
on the Sonar credential. #2160 was closed on 2026-10-08 as an obsolete experiment.

## Found during the audit

- **#2222's stuck-task dedupe still writes a duplicate row every five minutes (last week's #2, not
  fixed).** `hasDurableRecord` (`apps/api/src/scheduled/stuck-task-live-runtime.ts:230-236`)
  escapes the key `task_acp_session_live:idle` into a LIKE pattern over D1's 50-byte limit, so the
  dedupe read fails. Production observability D1 has 148 duplicate `info` rows for task
  `01M4NA86TV8PHK54JGKAYXPBJV` between 2026-10-11 18:10Z and 2026-10-12 06:26Z, and 240 for
  `01M4EQEJ9PS6Q4MKBKE6FY2FMB` earlier. Recorded on
  `2026-08-07-fix-stuck-task-sweep-pattern-complexity`.
- **An idle task-mode session was never put to sleep.** The same rows say task
  `01M4NA86TV8PHK54JGKAYXPBJV` (Phase 1 admin settings, `in_progress`) handed control back 15 h
  24 m ago with no turn or tool work in flight, and "No sleep is scheduled or in flight for it".
  It holds its workspace on a shared cx43 until the 24-hour runtime ceiling.
- **SAM autosave keeps committing runtime state and opening PRs.** #2310 is an autosave-opened,
  non-draft PR on the already-merged Wave B branch; it contains only `.do-state.md` and fails
  Preflight Evidence. Two autosave commits that touched the state files reached `main`'s history
  through merge commits (`ac037ed47` via #2303, `cba976fa1` via #2307), each later undone. On
  branches: 37 such commits since #2227, against none the month before. Recorded on
  `2026-07-19-repo-history-bloat-cleanup` and SAM idea `01M4E7NERTBA6NR9MJB193AW0J`.
- **`update_idea` truncates titles silently too.** A 215-character title was stored at 200
  characters with `updated: true` and no notice (`apps/api/src/operations/idea-core.ts:316`).
  Recorded on `2026-09-30-update-idea-append-silently-truncated-at-cap`.
- **The daily billing monitor had two blind days in seven.** On 10-08 and 10-11 its workspace had
  no `node_modules`, so `pnpm quality:cloudflare-cost` failed (`tsx` not found) and the day was
  classified `unknown`. New SAM idea `01M4QCYXTJQTGQC4VWZFXV5TR2`.
- **An expired chat's details panel shows "Cancelled"** in a badge with an undefined colour token,
  while the header chip says "Expired" (from #2280). Recorded on
  `2026-04-24-session-header-a11y-token-fixes`.
- **The completed 2026-09-04 relief plan is still armed in production.** All 31 of its variables
  (`PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_*`, `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_*`) are still set
  in the `production` Environment and ship as Worker text bindings, with both `…_ENABLED` flags
  `true`. Its preflight completed on 09-04, and the cleanup was bound to the approved manifest on
  09-14. The plan itself says to turn the preflight off afterwards. Removing the variables is an
  operator action, and it would free 31 of `sam-api-prod`'s 175 text bindings. Recorded on
  `tasks/archive/2026-09-03-projectdata-production-capacity-emergency.md`.
- **The 10-11 recovery wave is stalled with two items unmerged.** C (#2302, mission double-start)
  is green and mergeable but held on a live staging mission that needs new spend Raphaël has not
  approved. A (#2305, empty-node reaping) is a draft with 3 failing checks and a sleeping owner.
  The PR Shepherd stays paused until the wave ends.

## Backlog: 212 → 210

### Verdict tally (212 files audited)

| Verdict                                    | Files | Action                                                    |
| ------------------------------------------ | ----: | --------------------------------------------------------- |
| UNCHANGED                                  |   166 | Kept, no edit                                             |
| UNCHANGED with a corrected fact or pointer |    25 | Kept, dated `Reconciliation 2026-10-12` note              |
| PROGRESS                                   |    17 | Kept, `Reconciliation 2026-10-12` block with what is left |
| UNSURE                                     |     2 | Kept                                                      |
| SHIPPED                                    |     2 | One deleted, one archived                                 |
| SUPERSEDED, DUPLICATE or OBSOLETE          |     0 | —                                                         |

Edits were insert-only: one dated block near the top of each of 42 files. No body text was
rewritten, no checkbox changed. One exception: I corrected a sentence in a block that a reviewer
had just inserted (`2026-07-04-fix-flaky-tests-at-root`), because it pointed at a file this run
archived.

### Removed (2), one line each

- `2026-07-29-observability-info-events-persisted-as-errors` (shipped, **deleted**). #2291
  (`d4fa4f372`) limits the noise gate's repeated-error query to `level = 'error'`
  (`scripts/quality/check-observability-noise.ts:351`), with a real-SQLite regression test
  (`check-observability-noise.test.ts:122`). ACP lifecycle events have been reported at info level
  since #892, pinned by `TestSessionHostReportLifecycleSeverityMapping`. The noise gate
  (`quality:observability-noise`) passed on staging on 2026-10-12. Nothing links to its path;
  only ledger lists name it.
- `2026-10-07-credential-limits-randomized-order-assertion` (shipped, **archived**). It was fixed
  by #2213 (`57aaa057b`) before it was filed: the expected pair is sorted
  (`credential-limits-vertical-slice.test.ts:200`), and `references()` sorts the actual values
  (`:85`). Archived because `tasks/archive/2026-10-07-session-runtime-contract.md` links to it
  (repointed).

### Checked and kept

The 2026-10-08 queue idea (`01M4DR7MBDD8AAVF1XMC2XYQEX`) asked for three files to be closed in the
next tasks PR. The first was confirmed and archived (above). The other two stay:

- `2026-10-02-rebuild-grouped-fts-after-wall-recovery`: the "obsolete, 42/42 recoveries 200"
  evidence cannot be re-read, because recovery results are only logged and those logs are gone.
  The at-cap fallback that leaves stale postings is still live code, and a rule-42 code comment
  (`grouped-fts-wall-recovery.ts:31`) names this file as its tracker.
- `2026-10-04-instant-generation-aware-callback-token-renewal`: zero 401s appeared in the
  retained 7 days of 10%-sampled `request_rejected` logs. That supports its close rule for this
  window only, and closing it is Raphaël's call.

### Progress since 2026-10-05, block added (17)

- `2026-02-20-agent-session-startup-optimization`: #2261 resolves agent settings in the control plane (settingsResolved), so bootstrapped and contract-carrying restored starts skip the VM settings fetch; corrects the 10-05 "still sequential" line.
- `2026-02-27-tdf-1-task-state-machine`: #2264 optimistic lock on conversation close (409 on race) with a real-SQL race test; event writes still separate.
- `2026-03-03-simplify-deploy-scripts-and-infra`: #2303 moved the environment-override report to its own module (sync-wrangler-config.ts 1,463 → 1,327 lines).
- `2026-03-16-mcp-page-size-limits-not-configurable`: #2293 made 3 of the 5 MCP page-size limits configurable and documented; session limits still hardcoded.
- `2026-04-09-trigger-api-optimizations`: #2258 moved MCP trigger creation onto the shared Drizzle createTrigger; the [vars] item is superseded by rule 07 (#2303); failure ordering still open.
- `2026-04-18-multi-level-override-framework`: #2261 records the resolved model, effort and permission mode on each session (values, not the tier that supplied them).
- `2026-04-26-durable-interrupts-test-gaps`: #2213 moved notify/deliver onto agent channels and added workerd tests for the MCP→ProjectData hops; VM-agent hop, G3, G4 open.
- `2026-05-06-compact-mode-test-coverage-gaps`: #2287 deleted the summarize route and its test, so that item is moot; ToolCallCard items open.
- `2026-06-20-agent-crash-loop-kitty-keyboard-escape`: #2236 caps orchestrator check-ins at 3 and raises a needs_input marker; root cause and escape handling open.
- `2026-07-04-fix-flaky-tests-at-root`: #2271 fixed the repo-selector flake this file names (plus two Go flakes); the rest open.
- `2026-07-17-stale-playwright-audit-specs`: #2287 took fork-retry-new-chat-audit out of quarantine; 98 of 124 specs still quarantined.
- `2026-07-20-instant-ping-container-died-midsession`: #2240 fixed the 10-05 sleeping refusal; the node-error refusal moved (#2213) but is unchanged.
- `2026-08-03-durable-follow-up-prompt-delivery`: #2291 added server-side Idempotency-Key handling on the follow-up prompt route; the web client sends none.
- `2026-08-04-auto-commit-push-guard-false-positive-manual-workspaces`: #2261 makes the Instant caller send defaultBranch; manual, trial and node-lifecycle callers do not.
- `2026-08-09-staging-session-task-reconciliation-repair-failures`: #2279 fixed the foreign-key insert and production went to 0; the staging residual is stuck at 139.
- `2026-08-23-knowledge-injection-followups`: #2213 split instruction-tools.ts (699 → 372 lines); knowledge.ts and items 1, 3-6 remain.
- `2026-09-26-trustworthy-task-status`: #2280 and #2281 resolved items 1-4 (Expired end state, purge, sweep); only the staging check of #2153 remains.

### Corrected or extended, note added (25)

- `2026-02-20-orphaned-session-detection-and-recovery`: stop handler pointer moved to agent-sessions.ts:328-373 (#2208/#2217); the failed-VM-call-still-marks-stopped item stays open.
- `2026-02-23-worktree-redesign`: notes that pages/Workspace.tsx was split long ago (#592).
- `2026-02-28-mobile-nav-dropdown-menus`: both cited paths are gone; header now WorkspaceHeader.tsx:178-264.
- `2026-03-09-llm-task-prioritization`: the cited research doc was deleted by #1174; the note gives the git show command to recover it.
- `2026-03-16-notification-phase2-perf-followups`: the 'suppressed' caller moved to human-input-tool.ts:168 (#2213).
- `2026-03-16-notification-test-coverage-gaps`: gap 9 code moved to human-input-tool.ts:80-81 (#2213).
- `2026-03-17-mcp-token-do-storage-security`: pointers moved; #2276 added a second revoke site.
- `2026-03-18-gcp-self-hosting-docs`: criterion pointed at a nonexistent docs/guides/self-hosting.md; the real guide is self-hosting.mdx.
- `2026-03-18-workspace-mcp-server-p2`: new overlap: the SAM Connector's sam_project_get (#2294) vs the planned get_project_context.
- `2026-03-19-mcp-notification-waituntil`: cited lines no longer exist; task-tools.ts is now 454 lines (#2293/#2307).
- `2026-03-30-enforce-per-project-task-execution-timeout`: the env max now also gates #2232's Clef stall-kill path; per-project value still unread.
- `2026-04-01-replace-source-contract-tests`: #2294 repointed 11 files' submit-route reads to the service file; 27 still read route source.
- `2026-04-13-knowledge-graph-hardening`: the KNOWLEDGE_* [vars] item is superseded by rule 07 (#2303); other items open.
- `2026-04-19-trial-late-audit-hardening`: four cited pointers moved; one now pointed past the end of the shortened wrangler.toml (#2303).
- `2026-04-24-session-header-a11y-token-fixes`: new #2280 finding: an expired chat's details-panel task badge reads "Cancelled" with an undefined colour token (item #10).
- `2026-07-12-cf-container-wake-restore-hardening`: #2261 moved three cited locations and added timeouts before /restore, not to /restore itself.
- `2026-07-19-repo-history-bloat-cleanup`: the auto-commit now stages .do-state.md/.workflow-state.md (37 commits since #2227; two reached main's history via #2303/#2307, net zero); idea 01M4E7NERTBA6NR9MJB193AW0J.
- `2026-08-04-instant-persistence-step-renders-as-provisioning-vm`: #2231 moved the restore effect to useProvisioningTracker.ts:143-198; symptom unchanged.
- `2026-08-07-fix-stuck-task-sweep-pattern-complexity`: #2222's LIKE dedupe is still live in production: 148 duplicate rows for task 01M4NA86TV8PHK54JGKAYXPBJV in 12 h; pointer: #2279 moved the mismatch dedupe.
- `2026-09-08-ended-chat-requests-deleted-workspace`: #2231 moved the sibling effect to useProvisioningTracker.ts:147-198.
- `2026-09-08-staging-capacity-query-and-deploy-reset-noise`: UNSURE since 09-30, kept; #2279 now stores request-path failed queries as redacted with a cause code.
- `2026-09-09-chat-requests-reaped-task-404`: #2231 retries the failing GET up to 3 more times, including on 404 (up to 4 calls per open).
- `2026-09-23-resource-sparkline-gap-marker-has-no-colour`: scope grew to 28 files (#2294 ConnectorChip.tsx); SessionHeader pointers moved by #2238/#2280; fg-secondary still undefined.
- `2026-09-25-reporter-session-switch-unsent-rows`: the 09-30 pointer :165 now lands in SetWorkspaceID; SetSessionID is at reporter.go:182.
- `2026-09-30-update-idea-append-silently-truncated-at-cap`: #2293 moved the code to operations/idea-core.ts; #2294 exposes it to the SAM Connector (sam_idea_update), still with no truncation notice.

### Unsure, kept (2)

- `2026-10-02-rebuild-grouped-fts-after-wall-recovery`: kept: the 10-08 "obsolete (42/42 recoveries 200)" claim cannot be re-read (logs gone), the at-cap fallback is live code, and a rule-42 code comment tracks this file.
- `2026-10-04-instant-generation-aware-callback-token-renewal`: kept: zero 401s in the retained 7 days of 10%-sampled request_rejected logs supports AC1 for that window only; closing is Raphaël's call.

### Unchanged, no edit needed: 166

No merge this week touched their open scope; each was checked against this week's 70 merges. Notes on a few of them:

- `2026-02-23-suppress-background-subagents-in-acp`: UNSURE since 09-30, kept.
- `2026-04-10-git-show-colon-refspec-injection`: flagged since 09-30 as a candidate for a human won't-fix decision.
- `2026-05-11-duplicate-task-session-finalization`: open PR #2302 covers MCP and /sam dispatch, not the orchestrator path this file names.
- `2026-07-14-stabilize-codex-crash-recovery-reporting-tests`: UNSURE since 09-30, kept.
- `2026-07-19-instant-session-capacity-controls`: #2294 adds a Connector entry point that can land on Instant, limited only by connector start budgets.
- `2026-07-25-translate-proxy-sampling-params-4-7-plus`: #2235 added claude-sonnet-5-5, so more models hit the translate path.
- `2026-10-09-cc-attachment-mutations-take-45-seconds`: new since 10-05, fully audited; every claim still holds.

All 166:

- `2026-02-15-vm-agent-in-place-binary-update`
- `2026-02-16-additional-cloud-providers`
- `2026-02-16-sidebar-redesign-tier2`
- `2026-02-17-persistent-terminal-sessions`
- `2026-02-17-vm-log-browser`
- `2026-02-20-acp-reconnect-replay-integration-test`
- `2026-02-20-acp-session-error-observability`
- `2026-02-23-suppress-background-subagents-in-acp`
- `2026-02-24-vm-agent-process-lifecycle-and-stability`
- `2026-03-03-improve-test-infrastructure`
- `2026-03-03-simplify-durable-objects-and-schema`
- `2026-03-03-simplify-shared-packages`
- `2026-03-03-simplify-vm-agent-architecture`
- `2026-03-03-simplify-web-app-components`
- `2026-03-03-task-completion-lifecycle`
- `2026-03-04-system-reliability-and-maintainability-hardening`
- `2026-03-07-research-chat-truncation-causes`
- `2026-03-09-fix-task-status-display`
- `2026-03-10-log-viewer-test-coverage-gaps`
- `2026-03-12-bootstrap-token-dual-auth-dead-code`
- `2026-03-13-binary-install-security-hardening`
- `2026-03-13-scaleway-provider-improvements`
- `2026-03-13-wire-provider-env-var-overrides`
- `2026-03-14-fork-dialog-ui-polish`
- `2026-03-14-unified-session-task-workspace-state-machine`
- `2026-03-15-agent-profiles-4-system-prompt-injection`
- `2026-03-16-compute-lifecycle-test-gaps`
- `2026-03-16-notification-security-followups`
- `2026-03-16-notification-ui-accessibility-followups`
- `2026-03-16-port-exposure-security-hardening`
- `2026-03-17-acp-subagent-idle-detection`
- `2026-03-17-dispatch-push-parent-branch`
- `2026-03-18-code-context-for-task-submission`
- `2026-03-18-fix-git-identity-conversation-mode`
- `2026-03-19-chat-view-transitions`
- `2026-03-19-graph-execution-model`
- `2026-03-19-virtual-scrolling-test-coverage-gaps`
- `2026-03-24-deployment-settings-ui-fixes`
- `2026-03-28-file-raw-security-hardening`
- `2026-03-28-migrate-file-proxy-token-to-auth-header`
- `2026-03-30-account-map-db-indexes`
- `2026-04-03-split-oversized-files`
- `2026-04-08-credential-helper-per-workspace-directory`
- `2026-04-09-document-heartbeat-acp-sweep`
- `2026-04-10-git-show-colon-refspec-injection`
- `2026-04-10-route-level-error-message-leakage`
- `2026-04-10-web-lazy-loading-error-boundaries-a11y`
- `2026-04-12-credential-validity-quota-bypass`
- `2026-04-12-devcontainer-config-secondary-paths`
- `2026-04-13-knowledge-graph-test-coverage`
- `2026-04-18-agent-key-card-accessibility`
- `2026-04-18-credentials-miniflare-integration-tests`
- `2026-04-18-project-credentials-followups`
- `2026-04-18-project-credentials-missing-tests`
- `2026-04-18-project-credentials-playwright-audit`
- `2026-04-19-trial-orchestrator-boot-test-coverage-gaps`
- `2026-04-19-trial-orchestrator-step-handler-coverage`
- `2026-04-19-trial-sse-abort-propagation`
- `2026-04-19-trial-sse-cursor-persistence`
- `2026-04-20-platform-trial-enabled-env-var`
- `2026-04-22-infrastructure-nav-and-platform-infra-admin`
- `2026-04-23-deploy-script-security-hardening`
- `2026-04-23-remove-docker-requires-from-vm-agent-systemd`
- `2026-04-24-library-like-escape-clause`
- `2026-04-27-sam-tools-post-review-improvements`
- `2026-04-30-unified-user-usage-stats`
- `2026-05-01-ai-proxy-credential-hardening`
- `2026-05-01-fix-playwright-desktop-test-infrastructure`
- `2026-05-01-wp6-openai-routing-integration-test`
- `2026-05-01-wp6-playwright-visual-audit`
- `2026-05-03-harness-phase1-capable-coding-agent`
- `2026-05-03-harness-phase2-sam-platform-integration`
- `2026-05-10-lifecycle-state-accuracy`
- `2026-05-11-duplicate-task-session-finalization`
- `2026-05-19-error-banner-role-alert`
- `2026-05-20-amp-project-chat-mcp-wiring`
- `2026-05-26-encrypted-swap-cloud-init`
- `2026-06-03-tts-phase-benchmark`
- `2026-06-04-error-node-cleanup`
- `2026-06-06-library-ui-a11y-preexisting`
- `2026-06-06-projectlibrary-rule18-split`
- `2026-06-07-leak-sweep-test-coverage-gaps`
- `2026-06-07-theme-switcher-playwright-coverage-gaps`
- `2026-06-08-same-org-submodule-repo-access`
- `2026-06-09-git-credential-loopback-container-binding`
- `2026-06-09-git-credential-node-token-fallback-hardening`
- `2026-06-11-compose-parser-test-coverage`
- `2026-06-12-deployment-provisioning-route-tests`
- `2026-06-12-timeline-drawer-post-merge-fixes`
- `2026-06-15-alternative-inference-providers-backend`
- `2026-06-17-deploy-engine-security-hardening-followups`
- `2026-06-18-api-composition-root-extraction`
- `2026-06-18-deploy-day2-ops-followups`
- `2026-06-18-vm-agent-bootstrap-pipeline`
- `2026-06-18-vm-agent-lifecycle-idempotent-shutdown`
- `2026-06-24-compose-publish-x-sam-routes`
- `2026-06-26-admin-user-resource-overview`
- `2026-07-12-gitlab-token-lock-rate-limit`
- `2026-07-12-multi-installation-cloudflare-namespaces`
- `2026-07-14-stabilize-codex-crash-recovery-reporting-tests`
- `2026-07-16-observability-mcp-outcome-parsing-gap`
- `2026-07-16-project-data-row-fault-isolation-audit`
- `2026-07-19-instant-launch-stuck-queued-on-disconnect`
- `2026-07-19-instant-session-capacity-controls`
- `2026-07-19-split-env-interface`
- `2026-07-21-extend-stale-instant-callback-guard-coverage`
- `2026-07-21-instant-container-request-timeout-cancellation`
- `2026-07-21-project-invite-role-and-link-gaps`
- `2026-07-21-remove-sandbox-env-fallbacks-from-container-runtime`
- `2026-07-23-byo-phase0-review-followups`
- `2026-07-23-credential-routes-preexisting-hardening`
- `2026-07-23-vultr-onboarding-wizard-parity`
- `2026-07-25-admin-ai-proxy-orphaned-default-model`
- `2026-07-25-translate-proxy-sampling-params-4-7-plus`
- `2026-08-04-flaky-vultr-ip-poll-error-test`
- `2026-08-04-report-issue-length-env-vars-cannot-raise-limits`
- `2026-08-04-shared-staging-do-migration-pinning`
- `2026-08-04-sleeping-status-renders-as-unknown`
- `2026-08-06-digitalocean-vultr-pagination-silent-truncation`
- `2026-08-06-harden-vm-incident-callback-lifecycle-binding`
- `2026-08-06-investigate-orphaned-projectdata-alarm-wall-time`
- `2026-08-06-isolate-standalone-agent-process-environment`
- `2026-08-06-project-orchestrator-cancel-status-events`
- `2026-08-06-reconciliation-dead-target-task-status-events`
- `2026-08-06-run-gate-ignores-platform-cloud-credential`
- `2026-08-06-wrangler-sync-env-parity-test-coverage-gap`
- `2026-08-07-durable-background-vm-provisioning`
- `2026-08-07-expand-frontend-query-cache-and-persistence`
- `2026-08-07-pre-destroy-safe-evidence-capture`
- `2026-08-08-debugging-overhaul-review-followups`
- `2026-08-11-clipped-overflow-debt-sweep`
- `2026-08-11-migrate-remaining-source-contract-ui-tests`
- `2026-08-11-project-agent-short-conversation-duplicate-message`
- `2026-08-11-trigger-paused-reason-signal`
- `2026-08-11-vm-agent-snapshot-degradation-union-mismatch`
- `2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end`
- `2026-08-18-cf-container-single-gate-harness-race`
- `2026-08-18-chat-agent-state-single-do-rpc`
- `2026-08-18-consolidate-hand-rolled-visibility-polls`
- `2026-08-18-project-data-id-name-identity-source`
- `2026-08-23-get-instructions-missing-observation-ids`
- `2026-08-23-policy-row-retention-bound`
- `2026-09-08-agent-version-metadata-not-published`
- `2026-09-08-staging-repeated-noop-storage-alarms`
- `2026-09-09-docs-site-table-cells-overflow-on-mobile`
- `2026-09-09-node-idle-timeout-project-setting-has-no-consumer`
- `2026-09-09-scheduler-explorer-slot-count-model`
- `2026-09-11-bookmark-anchored-d1-reads`
- `2026-09-12-split-project-data-archive-sharding-module`
- `2026-09-14-www-scrollable-table-wrappers-not-keyboard-focusable`
- `2026-09-19-volume-status-badge-and-create-time-status`
- `2026-09-23-playwright-audit-shell-mocks-crash`
- `2026-09-23-schedules-panel-hardcoded-poll-interval`
- `2026-09-25-composable-capacity-source-anchor-guard`
- `2026-09-25-split-permanent-session-recovery-refusals`
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

## SAM memory (Part 2, done through SAM MCP, not in this diff)

Recorded here so the next weekly run can see what changed.

- **Session review.** About 80 human-started sessions from 2026-09-28 to 2026-10-12 were read for
  corrections and frustration. 10-05 to 10-11 were read in full; for earlier days the review
  relied on the 10-05 run plus spot checks.
  - **Coverage gap:** each project-wide message search reached only 4 of 136 archive owners, so
    older archived sessions may be under-covered.
  - **New this week:** on 10-10 and 10-11 Raphaël steered agents from ChatGPT through the SAM
    Connector. Some "Raphaël says…" instructions in project chats are therefore ChatGPT's
    paraphrase, and only quoted text inside them was treated as his words.
  - **Repeated patterns:**
    - Features he believed were done did not work end to end (missing UI, a missing harness, never
      wired up), in about nine sessions.
    - The system should clean up and repair itself without him, in three sessions.
    - Agents should recall earlier discussions before answering, in five sessions.
    - Short, plain answers, again, plus one explicit "Do not be sycophantic".
    - Handing the merge decision back: the last case was 10-06, and he now authorizes up front.
  - There was no swearing in this window. Frustration showed as "I'm confused", "That's not good"
    and "I find that suspicious".

- **Knowledge: 12 observations updated to current facts.**
  - `DurableObjectStorage`: the root object is below 9.0 GB (8.75 GB on 10-12); breaker closed;
    #2248 addressed the timeout class (`2efa5b9a`, superseding `84f18d5e`).
  - `CodexACP`: Sol 6.1 works inside SAM since #2234, with Codex CLI 0.160.0 / codex-acp 2.1.1
    (`432207ac`, superseding the 10-04 "still broken" note).
  - `ProjectTracking`: the 10-12 counts, plus why active files go stale. Files with post-merge
    acceptance steps merge while still active, and wave work often finishes in a recovery task
    (`35922a0f`).
  - `ExternalMcpConnectors`: still only the ChatGPT client; 26 operations, all success; no
    claude.ai client (`76703bc7`).
  - `SecretHandoffDesign`: the `SAM_MCP_TOKEN` gap in Claude Code shells, re-checked on 10-12
    (`cf85ee0d`).
  - `AgentDelegation`: wake soak at 35 claimed and 0 revoked (`07c6edf5`). PR Shepherd behaviour
    now includes the owner check, and the trigger is paused (`8db61a45`).
  - `Prioritization`: the queue idea is at 60,657 of 65,536 characters, so its next update should
    replace the content (`ea033bcf`).
  - Agent messaging (`a4f1d688`, `ad2d2c0f`): the event-channel design he liked on 10-01 shipped
    in #2213 and #2266. The old observations still called it "exploratory".
  - Provenance (`8a55bbab`): #2213 shipped notify/deliver provenance. ChatGPT-relayed and urgent
    messages still need sender checks.
  - Handing decisions back (`e35f367e`): adds the 10-06 case and notes that it has not recurred
    since.
- **Knowledge: 5 added.**
  - `ShippingVerification` `06e673a5`: this week's "done but not working end to end" cases.
  - `InfrastructureLifecycle` `1ef4a389`: the system cleans up and repairs itself, and a manual
    fix by him means a bug.
  - `Workflow` `03554a85`: recall earlier discussions before answering.
  - `ResponseStyle` `18ae795a`: no sycophancy.
  - `DevcontainerSecurity` `c297a808`: hardening must not break running deployments.
- **Knowledge: 1 retired, 2 confirmed.** Retired the 10-06 "storage stopped falling, breaker
  re-opened" observation (`2d9194f1`), which the 10-08 and 10-12 data supersede. Confirmed the
  10-10 storage-monitoring observation (`aeb0695a`) and the response-style observation
  (`c0e60e51`).
- **Policies: 3 task-scoped policies deactivated, because their work verifiably shipped.**
  - `a88ac3ad` (Sol for the October 7 wake fixes): #2261, #2262 and #2264.
  - `39e3f167` (the 2026-10-08 reliability wave): all 10 items merged and deployed by 10-09. Its
    "Expired, not Failed" decision shipped in #2280 and #2281.
  - `d73204ef` (keep the Sol profile during GPT-6.1 work): #2234; idea `01M45CXE5ZG10WTT30V5HCSY9V`
    was completed on 10-08 with production evidence.
- **Policies: none added or changed.** Policy `3ea7019e` (staging is the default; skip it only with explicit permission) is unchanged. He waived staging task by task this week, which fits it. The broader "use staging only when it validates something" wording appears only in a ChatGPT relay (10-10), so it needs his direct confirmation. The "system cleans up after itself" expectation is stored as knowledge, not a policy.
- **Ideas:**
  - Narrowed and retitled `01M496QHP8MY2S8W3F2BJPV2XN` (PR Shepherd). The owner check shipped;
    still open are the paused trigger and the merge bucket's missing current-head Sonar and
    CodeRabbit-wait checks.
  - Retitled `01M0YZNBKSKQZ47NC0K7M8N5AX` (ProjectData relief plan: target met; Slice C unmerged).
    Title only, because its text is at the cap.
  - Updated the living queue `01M4DR7MBDD8AAVF1XMC2XYQEX` in place with a 10-12 reconciliation and
    v5 ranking.
  - Appended new evidence to `01M4E7NERTBA6NR9MJB193AW0J` (autosave) and to
    `01KZZ9Y0B4957R9KR40TNEE3KP` (idle task-mode session never slept).
  - Created `01M4QCYXTJQTGQC4VWZFXV5TR2` (billing monitor blind days).
  - Nothing was marked completed this run. The only candidates were already completed by their
    own tasks.

## Genuinely open for the week of 2026-10-13 (ranked)

1. **Finish or formally close the stalled 10-11 recovery wave.** C (#2302, mission double-start:
   11 of 123 missions ever double-started, 9 failed) is green and mergeable, but its live staging
   mission needs new spend Raphaël has not approved. The decision: approve one bounded staging
   mission, or accept the existing tests for merge. A (#2305, empty-node reaping) is a draft with 3
   failing checks and an owner asleep since 10-11 15:11Z. The PR Shepherd stays paused until the
   wave ends, so open PRs pile up meanwhile.
2. **#2222's stuck-task dedupe writes a duplicate row every five minutes.** This was last week's #2
   and is still not fixed: 148 duplicate rows in 12 h for one task. XS fix plus a 50-byte guard.
   (`tasks/backlog/2026-08-07-fix-stuck-task-sweep-pattern-complexity.md`)
3. **An idle task-mode session went 15 h without being slept.** Find out why automatic sleep never
   scheduled task `01M4NA86TV8PHK54JGKAYXPBJV` (policy `d08d64dc`). (SAM idea
   `01KZZ9Y0B4957R9KR40TNEE3KP`)
4. **SAM autosave commits runtime state and opens PRs from intermediate turns.** #2310 is an
   autosave-only PR on an already-merged branch; #2304 carries 13 autosave commits. (SAM idea
   `01M4E7NERTBA6NR9MJB193AW0J`)
5. **Phase 1 admin settings (#2304) has stalled.** It is approved (policy `9017df94`), but its
   owner has been idle since about 10-11 15:00Z and 2 checks fail.
6. **Decisions and operator actions for Raphaël.** Close #1788 and #1817 (recommended), decide
   #2062, give #2265 the Sonar credential, close #2310, and fix or close blog PR #2306 (its
   Marketing Site build and Preflight Evidence fail). Also disarm the completed 2026-09-04 relief
   plan: it has 31 production Environment variables, both `…_ENABLED` flags are still `true`, and
   removing it frees 31 Worker text bindings.
7. **SAM Connector.** The claude.ai connection has never been tested (only ChatGPT is
   registered). Hardening is still open: an unguarded `JSON.parse`, failures returned as HTTP 200
   without logs, and refresh-token reuse revoking the connection. (SAM idea
   `01M4GJ0W0DS5BTKBM1YW0X5YC8`)
8. **`update_idea` silently truncates content and titles,** now also through the Connector's
   `sam_idea_update`. It cut a title during this run.
   (`tasks/backlog/2026-09-30-update-idea-append-silently-truncated-at-cap.md`)
9. **Claude Code agents cannot redeem webhook claim URLs,** because their shells have no
   `SAM_MCP_TOKEN`. (SAM idea `01M4APQ4QRN7S3JC1JH0SGMYFG`)
10. **The daily billing monitor has blind days** (no `node_modules` in its workspace on 10-08 and
    10-11). XS trigger or profile fix. (SAM idea `01M4QCYXTJQTGQC4VWZFXV5TR2`)

Observe this week, not work:

- The wake soak: 35 of 50+, 0 revoked, ends about 10-17.
- The old-agent drain re-check, due 2026-10-13 05:46Z (idea `01M474AV9DBFPBKPKAZ6PZXDTV`).
- The first real eviction on the #2300 path.
- The breaker-open alert.
- ProjectData's continued fall: 8.75 GB, falling 60 to 120 MB a day.

Also open and unchanged:

- Git access single-shot fetches (`01M3PHNEVYG4RP9QBF4YAN4QJ6`, `01M4677Q5M238BSZV86GH0SHCZ`).
- The Instant edge cases (`01M4GR94MHGTS41SKQAH9W3P0X`, `01M4EXYXWE9PCBRC0CGMH1HMR4`,
  `01M4GRNT9882NVT07TN1W2XX0W`).
- ACP live-proof gaps (`01M3P2E0JJNQRXX020P65ZRKEJ`).
- The Playwright quarantine (98 of 124 specs).
- The `.codex/config.toml` auto-commit revert (`2026-07-19-repo-history-bloat-cleanup`).

## Implementation checklist

- [x] Verify each of the 7 active files against its landing PR, the first successful production
      deploy containing the merge, the owning (often recovery) SAM task, and the production state
      its criteria name; archive shipped files with a provenance footer
- [x] Tick stale boxes only with cited evidence; leave the rest unticked with the reason on the line
- [x] Repoint every citation of a moved task path
- [x] Delta-audit all 212 backlog files against this week's 70 merges (8 parallel read-only
      reviewers, line-balanced batches); fully audit the 2 files new since 10-05
- [x] Remove backlog files only on a verified delete-class verdict; archive and repoint instead
      when anything that remains references the path
- [x] Add a `Reconciliation 2026-10-12` block to every file with new progress or a corrected fact
- [x] Record every finding the audit verifies (backlog notes or SAM ideas)
- [x] Post a status nudge or park decision on #1788, #1817 and #2062
- [x] Record the full ledger here, then move this file to `tasks/archive/`

## Acceptance criteria

- [x] `tasks/active/` is empty. Six files are merged, deployed and verified.
- [x] The ProjectData emergency's 9.0 GB target was met on 10-10 through archive sharding. Its
      relief-plan outcome is recorded as unknown, not as done.
- [x] Every archived file states how it shipped, and no box is ticked without evidence.
- [x] Every backlog removal has a one-line rationale in the PR description and in this ledger.
- [x] No citation in the repo points at a task path this PR moved or deleted.
- [x] Each open PR older than 7 days has a new 2026-10-12 comment.
- [x] The before/after file arithmetic closes exactly (see Outcome).
- [x] No task file that was prettier-clean at base became unclean (35 stayed clean; 20 were already
      unformatted at base and were left as they were).
