# Weekly queue reconciliation — 2026-10-05

**SAM task:** `01M45AG431MM1A1ERVN3PJ2HZK`
**Branch:** `sam/weekly-queue-memory-reconciliation-pj2hzk`
**Previous run:** `tasks/archive/2026-09-30-weekly-queue-reconciliation.md` (PR #2198)

## Problem

The repo's work-tracking surfaces drift from shipped reality. Merged work sits in
`tasks/active/`, and `tasks/backlog/` collects entries that shipped, were superseded, or duplicate
each other. This run reconciles both against `main` and production so the queue shows only work
that is genuinely open, and posts a status or park decision on every open PR older than 7 days.

## Research findings

- The brief estimated about 75 active and 260 backlog files. The tree at `ee80b0ee0` held
  **9 active and 214 backlog** files: last week's run (#2198) had already cut the queue to 1 and 208.
- Backlog delta since #2198 (`fb6c928c4`): six new files (2026-10-02 and 2026-10-04, filed by
  #2215, #2224 and #2226), one modified (`2026-09-26-trustworthy-task-status`), none removed.
  208 + 6 = 214.
- 26 PRs merged between 2026-09-30 07:46Z and 2026-10-05. Production deployed `main` HEAD
  `ee80b0ee0` successfully (Deploy Production run 37245799681, 2026-10-05 00:00Z), so all 26 are
  live.
- Open PRs older than 7 days: #1788, #1817, #2020, #2062 and #2160. Nothing changed for any of
  them since 2026-09-30 except drift from `main`.

## Method

1. Built the evidence base: the 26 merged PRs with merge commits, touched paths and summaries; the
   Deploy Production run history; last week's per-file verdicts for 206 of the 214 backlog files.
2. Audited the 8 ACP and GPT-6.1 active files with one reviewer. It established the landing PR,
   the merge commit and the first successful production deploy for each, and read the deployed
   values of the three ACP flags from the production Worker settings. The ProjectData emergency
   file was audited by hand against read-only production D1.
3. Delta-audited all 214 backlog files with seven parallel read-only reviewers (line-balanced
   batches of 11 to 42 files). Each file was checked against the code in `main`, not against PR
   titles. The 8 files with no 2026-09-30 verdict got a full audit. Verdicts: UNCHANGED, PROGRESS,
   SHIPPED, SUPERSEDED, DUPLICATE, OBSOLETE, UNSURE. The rule was "when unsure, keep".
4. Removed a file only on a verified delete-class verdict, and archived it instead of deleting it
   when anything that remains links to its path.
5. Verified every new production bug a reviewer reported, in code and in read-only production D1,
   before recording it.

## Outcome

| Directory        | Before |     After |
| ---------------- | -----: | --------: |
| `tasks/active/`  |      9 |     **1** |
| `tasks/backlog/` |    214 |   **213** |
| `tasks/archive/` |  1,167 | **1,177** |

Before: 9 + 214 + 1,167 = 1,390. After: 1 + 213 + 1,177 = 1,391. The difference of +1 is this
ledger (+1) and one new backlog entry (+1), minus one deleted backlog file (−1).

## Active: 9 → 1

### Archived (8)

Every one is merged and live. The reviewer ticked one box with cited evidence, left two unticked
with a reason on the line, and added a provenance footer to each file. In production,
`ACP_INTERACTIONS_ENABLED`, `ACP_INTERACTION_FORMS_ENABLED` and `ACP_INTERACTION_URLS_ENABLED`
read `true` (production Environment overrides set 2026-10-03 16:41Z, applied by run 37137757826).
The checked-in defaults are still `false`.

| File                                       | Shipped by                                                       | First production deploy              | Boxes left unticked                                         |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `2026-09-30-acp-c1-structured-forms`       | #2206 `989bf7bb6`; labels and release via #2217 `b79136805`      | run 36783707657                      | none                                                        |
| `2026-09-30-acp-permission-chat-ui`        | #2200 closed unmerged; its head shipped inside #2202 `86e6c5b75` | run 36744720219                      | none                                                        |
| `2026-09-30-acp-runtime-permission-bridge` | #2201 closed unmerged; its head shipped inside #2202 `86e6c5b75` | run 36744720219                      | none                                                        |
| `2026-09-30-activate-acp-permissions`      | draft #2204 landed via #2217 `b79136805`                         | run 37136649002 (flags: 37137757826) | none                                                        |
| `2026-09-30-add-gpt-6-1-sol`               | #2199 `762a97cf5`                                                | run 36697264202                      | live production catalog readback (route needs auth)         |
| `2026-09-30-integrate-acp-permissions`     | #2202 `86e6c5b75`                                                | run 36744720219                      | evidence handoff to a parent that was replaced (superseded) |
| `2026-10-01-acp-auth-diagnosis`            | #2209 closed unmerged; via #2210 into #2217 `b79136805`          | run 37136649002                      | none                                                        |
| `2026-10-01-acp-c2-url-elicitation`        | draft #2207 landed via #2217 `b79136805`                         | run 37136649002                      | none                                                        |

### Kept active (1)

`2026-09-03-projectdata-production-capacity-emergency`, with a dated 2026-10-05 block. It is
recovering on its own, but its headline criterion (at or below 9,000,000,000 bytes) is unmet:

- 9,719,410,688 bytes at 05:15Z (status `degraded`), down from 10.627 GB on 10-01 and falling 250
  to 370 MB a day.
- The breaker has been `closed` since 2026-10-02 16:29Z. Migrations: 452 published, 47 frozen, 0
  failed or poisoned.
- Slice C (`7868bc894`) is still unmerged, 217 commits behind `main`.

## Open PRs older than seven days

Each comment states only what changed since 2026-09-30 and the one decision that ends the park.

| PR                                     |  Age | Behind `main` | Comment                                                                                           | Decision needed                                                     |
| -------------------------------------- | ---: | ------------: | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| #1788 scheduled OSV scan               | 56 d |           811 | [5989368788](https://github.com/raphaeltm/simple-agent-manager/pull/1788#issuecomment-5989368788) | Build the private intake, or drop scheduled OSV scanning            |
| #1817 architecture workspace prototype | 53 d |           799 | [5989369431](https://github.com/raphaeltm/simple-agent-manager/pull/1817#issuecomment-5989369431) | Close (keep as an Idea) or commit to re-cutting as slices           |
| #2020 SonarQube Cloud coverage         | 31 d |           341 | [5989370007](https://github.com/raphaeltm/simple-agent-manager/pull/2020#issuecomment-5989370007) | `SONAR_TOKEN`, disable Automatic Analysis, set `SONAR_CI_ENABLED`   |
| #2062 sleep-progress moon asset        | 24 d |           295 | [5989370558](https://github.com/raphaeltm/simple-agent-manager/pull/2062#issuecomment-5989370558) | Show an animated moon for sleep progress, and where                 |
| #2160 shared Codex app-server spike    |  8 d |           182 | [5989371142](https://github.com/raphaeltm/simple-agent-manager/pull/2160#issuecomment-5989371142) | Keep parked until a native test account exists, or close as an Idea |

The first four have now had a weekly reconciliation comment since 2026-09-23 plus near-daily "PR
Shepherd" park comments, with no human reply. The decisions are repeated in the SAM digest.

## Found during the audit

- **A production bug from #2222, firing every five minutes.** `hasDurableRecord`
  (`apps/api/src/scheduled/stuck-task-live-runtime.ts:230-236`) binds a LIKE pattern of 51 to 69
  bytes, over D1's 50-byte limit. The dedupe read fails, is logged as a warning, and a duplicate
  `platform_errors` row is written each sweep: 59 rows for task `01M44DA3EDRCGNATD4R3FT0Y7A`
  (01:36Z to 06:27Z on 10-05) and 9 for `01M42YQA8QPJQBW48KTDQFAHDE` in production observability
  D1. Recorded on `2026-08-07-fix-stuck-task-sweep-pattern-complexity`, whose open regression guard
  would have caught it.
- **#2230's new `sleeping` task status is missing from the "active" status sets.** Verified in
  code: slept VM conversations drop out of the dashboard's Active Tasks, MCP `list_project_agents`
  and the account map, and `send_message_to_subtask` / `stop_subtask` refuse a slept child.
  Likely from code reading: opening a slept VM conversation renders the provisioning indicator and
  polls every 2 s. Filed as `tasks/backlog/2026-10-05-sleeping-task-status-follow-ups.md`. A
  `sleeping` task also has no terminal exit after the 7-day snapshot purge (item 3 of
  `2026-09-26-trustworthy-task-status`).
- **GPT-6.1 Sol still fails inside SAM.** Session `ba34fe12` (2026-10-04 21:20Z) got HTTP 400
  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account". SAM pins
  `@openai/codex@0.156.1` with the SAM C2 patch
  (`packages/vm-agent/internal/acp/gateway.go:32`, `codex_runtime_installer.sh`, both
  `apps/api` Dockerfiles), and public reports show the same error on 0.156.1. Raphaël confirmed
  Sol 6.1 works in his standalone Codex. The diagnosing task `01M42XKK2P41J0091Q8HQ93YJS` ended
  `failed` only because its workspace was deleted while it awaited a follow-up.
- **An agent auto-commit reverted a deliberate config change on `main`.** "chore: save agent work"
  `c9316fb3f`, carried in by #2217, set `.codex/config.toml` `model_reasoning_effort` back to
  `"low"`, undoing `2f78efcff` (`"medium"`). The vm-agent rewrites a SAM-managed block in that
  tracked file (`packages/vm-agent/internal/acp/codex_config.go:240-244`). Recorded on
  `2026-07-19-repo-history-bloat-cleanup`.
- **ACP permission prompts are effectively dormant in production.** Since #2225 every agent
  defaults to Bypass Permissions, so permission cards appear only for sessions set to Manual. Forms
  and URL requests are unaffected.
- **Untracked ACP release gaps.** Form and URL continuation were proven live only with Codex,
  although production offers both to every agent in conversation mode
  (`acp-interaction-runtime-config.ts:15-16`), and the auth-diagnosis live test matrix was never
  run (#2217 "Limits"). The 11 ACP chat-guidance Playwright tests #2217 added sit in a quarantined
  spec, so CI never runs them.

## Backlog: 214 → 213

### Verdict tally (214 files audited)

| Verdict    | Files | Action                                                                 |
| ---------- | ----: | ---------------------------------------------------------------------- |
| UNCHANGED  |   204 | Kept; 19 of them got a dated note with a corrected fact or new finding |
| PROGRESS   |     8 | Kept, with a `Reconciliation 2026-10-05` block                         |
| SUPERSEDED |     1 | Deleted                                                                |
| OBSOLETE   |     1 | Archived (an archived task links to it); link repointed                |
| DUPLICATE  |     0 | —                                                                      |

Three files that were UNSURE on 2026-09-30 are still kept (counted as UNCHANGED).

### Removed (2), one line each

- `2026-03-29-vm-agent-read-header-timeout` (superseded, **deleted**): fixed differently in #2217
  (`6a042d599`). The upload handler now sets its own read deadline from `FILE_UPLOAD_TIMEOUT`
  (`packages/vm-agent/internal/server/file_transfer.go:83-91`, real-socket test
  `file_upload_deadline_test.go`), and the short server `ReadTimeout` is kept on purpose for every
  other route. Only last week's ledger names it.
- `2026-07-11-codex-staging-oauth-refresh-token-revoked` (obsolete, **archived**): the symptom is
  gone. Fresh `openai-codex` VM and Instant turns completed on staging on 2026-10-03 for the same
  smoke user, during the #2207/#2217 runtime-distribution runs. Archived because
  `tasks/archive/2026-06-15-codex-acp-midprompt-disconnect.md` links to it (repointed).

### New entry (1)

- `2026-10-05-sleeping-task-status-follow-ups`: the #2230 `sleeping` gaps listed above.

### Progress since 2026-09-30, block added (8)

- `2026-02-20-acp-session-error-observability`: #2217 added bounded prompt-failure reason codes
  and creator-gated chat guidance.
- `2026-03-03-simplify-shared-packages`: #2225 deleted the unused permission-mode descriptions.
- `2026-03-07-research-chat-truncation-causes`: #2224 made a 401 non-terminal for the message
  reporter (B2's 401 case).
- `2026-04-01-replace-source-contract-tests`: #2225 replaced one route source-contract block with
  a real-SQL behavioral test.
- `2026-07-17-stale-playwright-audit-specs`: #2217 repaired part of the recoverable-error spec, but
  it stays quarantined (99 of 120 specs).
- `2026-08-04-sleeping-status-renders-as-unknown`: #2230 shipped the Sleeping badge and its test.
- `2026-08-11-vm-agent-snapshot-degradation-union-mismatch`: #2208 made the lifecycle-repair
  allowlist moot.
- `2026-09-26-trustworthy-task-status`: #2230's `sleeping` status takes VM conversations out of
  the false day-7 failure; Instant tasks, pre-#2230 rows and the post-purge end state remain.

### Corrected or extended, note added (19)

- `2026-08-07-fix-stuck-task-sweep-pattern-complexity`: the #2222 production recurrence above.
- `2026-07-20-instant-ping-container-died-midsession`: #2230 widened it (`sleeping` refused by MCP
  orchestration).
- `2026-07-19-repo-history-bloat-cleanup`: the `.codex/config.toml` auto-commit revert.
- `2026-03-30-enforce-per-project-task-execution-timeout`: premise corrected;
  `TASK_RUN_MAX_EXECUTION_MS` has not killed a live task since #1567.
- `2026-02-20-agent-session-startup-optimization`: scope grew (on-demand Codex runtime install at
  session start, #2217); stale code references flagged.
- `2026-03-14-unified-session-task-workspace-state-machine`: wrong file pointer corrected (#2223
  moved the code).
- `2026-07-12-cf-container-wake-restore-hardening`: all five cited locations moved by #2218.
- `2026-03-17-mcp-token-do-storage-security`: pre-split paths updated; #2230's wake reset adds no
  exposure.
- `2026-03-28-file-raw-security-hardening`: criterion 1 is owned by
  `2026-03-28-migrate-file-proxy-token-to-auth-header`.
- `2026-05-01-ai-proxy-credential-hardening`: #2224 renewal noted; links idea
  `01M432G3276YZWCP3HEJ5B25J5`.
- `2026-04-24-session-header-a11y-token-fixes`: item #10 must also cover `sleeping`.
- `2026-07-04-fix-flaky-tests-at-root`: two more load-sensitive tests.
- `2026-06-07-theme-switcher-playwright-coverage-gaps`: both specs it extends are quarantined.
- `2026-07-16-project-data-row-fault-isolation-audit`: a second tolerant `mapRows` already exists.
- `2026-09-23-resource-sparkline-gap-marker-has-no-colour`: now 27 files, plus two more undefined
  classes.
- `2026-09-25-split-permanent-session-recovery-refusals`: pointers corrected; #2230 rewrote
  `session-recovery.ts` (370 lines), so the cited `:456` no longer existed.
- `2026-09-25-stopping-sleep-with-failed-projectdata-session`: pointers corrected after #2223 and
  #2230 moved the code; cross-referenced to the #2230 failed-wake change.
- `2026-07-19-instant-launch-stuck-queued-on-disconnect`: the July-tasks sub-item is closable.
- `2026-07-25-admin-ai-proxy-orphaned-default-model`: #2199 added a second trigger.

### Unchanged, no edit needed: 185

No merge this week touched their open scope; each was checked against this week's 26 merges. Three of them were UNSURE on 2026-09-30 and stay kept: `2026-02-23-suppress-background-subagents-in-acp`, `2026-07-14-stabilize-codex-crash-recovery-reporting-tests`, `2026-09-08-staging-capacity-query-and-deploy-reset-noise`.

- `2026-02-15-vm-agent-in-place-binary-update`
- `2026-02-16-additional-cloud-providers`
- `2026-02-16-sidebar-redesign-tier2`
- `2026-02-17-persistent-terminal-sessions`
- `2026-02-17-vm-log-browser`
- `2026-02-20-acp-reconnect-replay-integration-test`
- `2026-02-20-orphaned-session-detection-and-recovery`
- `2026-02-23-suppress-background-subagents-in-acp`
- `2026-02-23-worktree-redesign`
- `2026-02-24-vm-agent-process-lifecycle-and-stability`
- `2026-02-27-tdf-1-task-state-machine`
- `2026-02-28-mobile-nav-dropdown-menus`
- `2026-03-03-improve-test-infrastructure`
- `2026-03-03-simplify-deploy-scripts-and-infra`
- `2026-03-03-simplify-durable-objects-and-schema`
- `2026-03-03-simplify-vm-agent-architecture`
- `2026-03-03-simplify-web-app-components`
- `2026-03-03-task-completion-lifecycle`
- `2026-03-04-system-reliability-and-maintainability-hardening`
- `2026-03-09-fix-task-status-display`
- `2026-03-09-llm-task-prioritization`
- `2026-03-10-log-viewer-test-coverage-gaps`
- `2026-03-12-bootstrap-token-dual-auth-dead-code`
- `2026-03-13-binary-install-security-hardening`
- `2026-03-13-scaleway-provider-improvements`
- `2026-03-13-wire-provider-env-var-overrides`
- `2026-03-14-fork-dialog-ui-polish`
- `2026-03-14-summarize-endpoint-hardening`
- `2026-03-15-agent-profiles-4-system-prompt-injection`
- `2026-03-16-compute-lifecycle-test-gaps`
- `2026-03-16-mcp-page-size-limits-not-configurable`
- `2026-03-16-notification-phase2-perf-followups`
- `2026-03-16-notification-security-followups`
- `2026-03-16-notification-test-coverage-gaps`
- `2026-03-16-notification-ui-accessibility-followups`
- `2026-03-16-port-exposure-security-hardening`
- `2026-03-17-acp-subagent-idle-detection`
- `2026-03-17-dispatch-push-parent-branch`
- `2026-03-18-code-context-for-task-submission`
- `2026-03-18-fix-git-identity-conversation-mode`
- `2026-03-18-gcp-self-hosting-docs`
- `2026-03-18-workspace-mcp-server-p2`
- `2026-03-19-chat-view-transitions`
- `2026-03-19-graph-execution-model`
- `2026-03-19-mcp-notification-waituntil`
- `2026-03-19-virtual-scrolling-test-coverage-gaps`
- `2026-03-24-deployment-settings-ui-fixes`
- `2026-03-28-migrate-file-proxy-token-to-auth-header`
- `2026-03-30-account-map-db-indexes`
- `2026-04-03-split-oversized-files`
- `2026-04-08-credential-helper-per-workspace-directory`
- `2026-04-09-document-heartbeat-acp-sweep`
- `2026-04-09-trigger-api-optimizations`
- `2026-04-10-git-show-colon-refspec-injection`
- `2026-04-10-route-level-error-message-leakage`
- `2026-04-10-web-lazy-loading-error-boundaries-a11y`
- `2026-04-12-credential-validity-quota-bypass`
- `2026-04-12-devcontainer-config-secondary-paths`
- `2026-04-13-knowledge-graph-hardening`
- `2026-04-13-knowledge-graph-test-coverage`
- `2026-04-18-agent-key-card-accessibility`
- `2026-04-18-credentials-miniflare-integration-tests`
- `2026-04-18-multi-level-override-framework`
- `2026-04-18-project-credentials-followups`
- `2026-04-18-project-credentials-missing-tests`
- `2026-04-18-project-credentials-playwright-audit`
- `2026-04-19-trial-late-audit-hardening`
- `2026-04-19-trial-orchestrator-boot-test-coverage-gaps`
- `2026-04-19-trial-orchestrator-step-handler-coverage`
- `2026-04-19-trial-sse-abort-propagation`
- `2026-04-19-trial-sse-cursor-persistence`
- `2026-04-20-platform-trial-enabled-env-var`
- `2026-04-22-infrastructure-nav-and-platform-infra-admin`
- `2026-04-23-deploy-script-security-hardening`
- `2026-04-23-remove-docker-requires-from-vm-agent-systemd`
- `2026-04-24-library-like-escape-clause`
- `2026-04-26-durable-interrupts-test-gaps`
- `2026-04-27-sam-tools-post-review-improvements`
- `2026-04-30-unified-user-usage-stats`
- `2026-05-01-fix-playwright-desktop-test-infrastructure`
- `2026-05-01-wp6-openai-routing-integration-test`
- `2026-05-01-wp6-playwright-visual-audit`
- `2026-05-03-harness-phase1-capable-coding-agent`
- `2026-05-03-harness-phase2-sam-platform-integration`
- `2026-05-06-compact-mode-test-coverage-gaps`
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
- `2026-06-20-agent-crash-loop-kitty-keyboard-escape`
- `2026-06-24-compose-publish-x-sam-routes`
- `2026-06-26-admin-user-resource-overview`
- `2026-07-12-gitlab-token-lock-rate-limit`
- `2026-07-12-multi-installation-cloudflare-namespaces`
- `2026-07-14-stabilize-codex-crash-recovery-reporting-tests`
- `2026-07-16-observability-mcp-outcome-parsing-gap`
- `2026-07-19-instant-session-capacity-controls`
- `2026-07-19-split-env-interface`
- `2026-07-21-extend-stale-instant-callback-guard-coverage`
- `2026-07-21-instant-container-request-timeout-cancellation`
- `2026-07-21-project-invite-role-and-link-gaps`
- `2026-07-21-remove-sandbox-env-fallbacks-from-container-runtime`
- `2026-07-23-byo-phase0-review-followups`
- `2026-07-23-credential-routes-preexisting-hardening`
- `2026-07-23-vultr-onboarding-wizard-parity`
- `2026-07-25-translate-proxy-sampling-params-4-7-plus`
- `2026-07-29-observability-info-events-persisted-as-errors`
- `2026-08-03-durable-follow-up-prompt-delivery`
- `2026-08-04-auto-commit-push-guard-false-positive-manual-workspaces`
- `2026-08-04-flaky-vultr-ip-poll-error-test`
- `2026-08-04-instant-persistence-step-renders-as-provisioning-vm`
- `2026-08-04-report-issue-length-env-vars-cannot-raise-limits`
- `2026-08-04-shared-staging-do-migration-pinning`
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
- `2026-08-09-staging-session-task-reconciliation-repair-failures`
- `2026-08-11-clipped-overflow-debt-sweep`
- `2026-08-11-migrate-remaining-source-contract-ui-tests`
- `2026-08-11-project-agent-short-conversation-duplicate-message`
- `2026-08-11-trigger-paused-reason-signal`
- `2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end`
- `2026-08-18-cf-container-single-gate-harness-race`
- `2026-08-18-chat-agent-state-single-do-rpc`
- `2026-08-18-consolidate-hand-rolled-visibility-polls`
- `2026-08-18-project-data-id-name-identity-source`
- `2026-08-23-get-instructions-missing-observation-ids`
- `2026-08-23-knowledge-injection-followups`
- `2026-08-23-policy-row-retention-bound`
- `2026-09-08-agent-version-metadata-not-published`
- `2026-09-08-ended-chat-requests-deleted-workspace`
- `2026-09-08-staging-capacity-query-and-deploy-reset-noise`
- `2026-09-08-staging-repeated-noop-storage-alarms`
- `2026-09-09-chat-requests-reaped-task-404`
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
- `2026-09-25-reporter-session-switch-unsent-rows`
- `2026-09-25-staging-allocation-plan-no-longer-current`
- `2026-09-25-structured-log-error-text-redaction`
- `2026-09-27-chat-switch-list-first-paint`
- `2026-09-27-workspace-chat-view-transcript-cache`
- `2026-09-28-workspace-page-chat-stop-sends-chat-session-id`
- `2026-09-29-flaky-harness-activity-coalesce-test`
- `2026-09-30-update-idea-append-silently-truncated-at-cap`
- `2026-10-02-rebuild-grouped-fts-after-wall-recovery`
- `2026-10-04-acp-client-tailwind-classes-not-generated`
- `2026-10-04-instant-generation-aware-callback-token-renewal`
- `2026-10-04-legacy-chat-user-links-invisible-light-mode`
- `2026-10-04-snapshot-relay-node-proof-in-body`
- `2026-10-04-update-after-bootstrap-workspace-token-writer`

## SAM memory (Part 2, done through SAM MCP, not in this diff)

Recorded here so the next weekly run can see what changed.

- **Session review.** About 75 sessions from 2026-09-21 to 2026-10-05 were read for human
  corrections and frustration. Every quote used for a policy was re-verified with
  `search_messages`. Coverage gap: each project-wide message search reached only 4 of 128 archive
  owners, so daytime 09-22 and 09-24 may be under-covered. Repeated patterns:
  - **Short, plain answers**, asked for in six sessions.
  - **"Did it actually ship?"**: work reported done that had not landed or did not fix the
    symptom, in nine sessions.
  - **Coordinators going dormant or missing their wake**, in six sessions.
  - **Agents handing decisions back** ("needs your OK", "want me to merge?"), in eight sessions.
  - **Direct links he can act on from his phone**, asked for in four sessions.
- **Knowledge, 18 observations updated** to current facts:
  - Sol 6.1 still fails inside SAM.
  - The sleep-loop facts fixed by #2218, #2223 and #2224.
  - #2230's stable task identity, with a pointer to the regression entry.
  - ProjectData at 9.72 GB and falling; the R2 orphan cost after #2220.
  - The project-tracking heuristics.
  - Three observations that attributed the ACP delivery coordinator's relayed review messages to
    Raphaël now say they came from the coordinator.
  - The per-node workspace cap observation is marked superseded (Raphaël, 09-25: "I want that
    shit out the fucking door").
  - The Jev "do not ship a generic passthrough" recommendation is marked contested by his 09-29
    "go broad" pushback.
  - The dormant-coordinator and response-style observations now carry the recurrence evidence.
- **Knowledge, 14 retired:**
  - One spent wave authorization (the 10-04 health wave shipped as #2222, #2223 and #2224).
  - Six PR #2210 review gates (the PR closed when #2217 shipped).
  - Three ACP-delivery coordination notes.
  - Five superseded PR-specific CodeRabbit waivers.
- **Knowledge, 8 added, 6 confirmed.** Added:
  - Ranked options in a SAM Idea for planning answers.
  - Chat-list ordering by conversation activity (#2228).
  - Agent-messaging provenance, with the misattribution as a live example.
  - Direct links.
  - Handing decisions back.
  - The new `ShippingVerification` entity.
  - Usage-limit wakes for coordinators.
  - Raphaël's 10-05 stalled-tool classifier direction.
- **Ideas:**
  - Completed: MCP lineage checks `01M0SD6W5SR7FWFVWTK7DWV318` (#1900, #2230), Commenting MVP
    `01M0JQB842XSJ3W172DYPB37HN`, exact Git-state restore `01M30PPM0B96G2RM1HC4Q7EHG6` (#2115).
  - Cancelled as duplicates: `01M3WYXYPX8F8H0QN0X8MBJNXK` → `01M3WACF99XYACR3TKHC19Z6JZ`, and
    `01KW4D1HKGCV2N8VDNB3Y7BTDX` → `01M43B7Q8HC87N3AEW187Q6BMT`. The survivors absorbed their
    evidence.
  - Narrowed or retitled: stable task identity follow-ups `01M43NCRFC9VF93RPM355FZAKJ`, legacy
    recovery rows `01M3WACF99XYACR3TKHC19Z6JZ`, file commenting Phase 2
    `01M0N1250YESBW2R497KXDZVSC`. Title-only for the two plans already full at 64 KiB: ACP
    `01M3P2E0JJNQRXX020P65ZRKEJ` and ProjectData `01M0YZNBKSKQZ47NC0K7M8N5AX`.
  - Status notes on 10 more ideas.
  - Created: GPT-6.1 Sol fails inside SAM, `01M45CXE5ZG10WTT30V5HCSY9V`.
- **Policies:**
  - **Deactivated 7** task-scoped policies whose work verifiably shipped: `38df5a88` (#2030),
    `805199d8` (#2059), `390ef351` (eventing, #2075), `fb2f6edf` (#1898), `1e946849` (commenting
    MVP), `f8bed08d` (#1824), `528fc2af` (ACP delivery). The cap counts only policies that apply
    now, and it had blocked three explicit saves this week.
  - **Added 2**, for explicitly and repeatedly stated preferences: `be92174d` (keep chat replies
    short and plain, one question at a time) and `d465ac2d` (give direct links for anything
    Raphaël may act on).
  - **Clarified 1:** `d60830e2` now says a direct change request authorizes merging once every
    gate passes. This follows his 10-04 "Not sure I follow. Why did you not merge?" and his 10-03
    "create a PR, get it green, get it shi[p]ped as soon as possible".
  - Live policies: 99 before, 94 after (cap 100).
  - Not changed: `d73204ef` (keep the Sol profile on gpt-6.1-sol) stays, because the
    compatibility work is not finished. Policy `66060db4`, which held the ProjectData destructive
    gates, expired on 2026-09-22 and was not renewed (nobody restated it).
- **Not recorded, deliberately:** "Go one step deeper…" (a one-off correction that rule 39
  covers), and "each batch can overlap by a bit" (specific to one coordinator). The
  `.workflow-state.md` request ("Ok. Make that happen.") is draft PR #2227.

## Genuinely open for the week of 2026-10-06 (ranked)

1. **#2230's `sleeping` status is missing from the "active" status sets.** It affects every VM
   sleep since 2026-10-05 00:00Z. Slept conversations vanish from Active Tasks,
   `list_project_agents` and the account map. Agents cannot message (`send_message_to_subtask`,
   `send_durable_message`) or stop a slept VM agent, which breaks "sleep and be durably woken" for
   coordinator → child messages. A slept chat likely renders as provisioning.
   (`tasks/backlog/2026-10-05-sleeping-task-status-follow-ups.md`, SAM idea
   `01M43NCRFC9VF93RPM355FZAKJ`)
2. **#2222's stuck-task dedupe writes a duplicate `platform_errors` row every five minutes.** Its
   LIKE pattern is over D1's 50-byte limit (59 rows for one task in five hours). A small fix, plus
   the ≤ 50-byte regression guard that would have caught it.
   (`tasks/backlog/2026-08-07-fix-stuck-task-sweep-pattern-complexity.md`)
3. **A failed VM wake still fails the conversation.** Since #2230 it fails the conversation's own
   task and fires the parent's task-wait hooks. (SAM idea `01M3MFDMZ5AS0BXPHZWS3CRFED`,
   `tasks/backlog/2026-09-25-stopping-sleep-with-failed-projectdata-session.md`)
4. **GPT-6.1 Sol is unusable inside SAM.** The pinned Codex CLI `0.156.1` rejects it for ChatGPT
   accounts. Rebase the SAM C2 patch onto a current Codex CLI and keep its design constraints.
   Raphaël tried it several times on 10-04. (SAM idea `01M45CXE5ZG10WTT30V5HCSY9V`)
5. **"Expired, not failed."** 11 of the 34 tasks that failed since 2026-09-30 were lifecycle
   outcomes: 4 expired human-input requests, 6 day-7 runtime verdicts, and 1 deleted workspace
   while awaiting a follow-up. A `sleeping` task also has no terminal exit after the 7-day purge.
   (`tasks/backlog/2026-09-26-trustworthy-task-status.md`, SAM idea `01KZNGJG1DCH8DBC835Y0272P4`)
6. **ProjectData root object to ≤ 9.0 GB.** It is recovering on its own (9.72 GB, falling 250 to
   370 MB a day). Re-measure around 10-08; land Slice C (`7868bc894`) if the drain flattens; then
   rebuild grouped FTS. (`tasks/active/2026-09-03-projectdata-production-capacity-emergency.md`)
7. **`update_idea` silently drops appends at 64 KiB.** The ACP and ProjectData plans are full; this
   run had to retitle them instead of appending.
   (`tasks/backlog/2026-09-30-update-idea-append-silently-truncated-at-cap.md`)
8. **ACP live-proof gaps.** Forms and URL requests were proven live only with Codex, but production
   offers them to every agent; the auth-diagnosis live matrix was never run; #2217's 11 ACP
   Playwright tests sit in a quarantined spec. (SAM idea `01M3P2E0JJNQRXX020P65ZRKEJ`,
   `tasks/backlog/2026-07-17-stale-playwright-audit-specs.md`)
9. **Agent auto-commits rewrite the tracked `.codex/config.toml`.** One silently reverted
   `model_reasoning_effort` to `"low"` on `main` (via #2217). Decide the intended value and stop
   the vm-agent writing SAM-managed config into a tracked file.
   (`tasks/backlog/2026-07-19-repo-history-bloat-cleanup.md`)
10. **Five parked PRs need Raphaël's call.** #1817 close or commit (799 behind), #1788 OSV intake,
    #2020 Sonar account actions, #2062 moon asset, #2160 Codex app-server spike.

Also open, unchanged this week: prompt-cancel section B (SAM idea `01M31M9G3T4SEWT9ZW1BM4QKZ3`);
the per-profile agent admin switch §8 (`01M388Y1Q1068DNT69KTBFXSMB`, two premises now stale after
#2202/#2225); the staging-contention check (`01M3M0AK930MJXX12TFT9VJ3PH`); check-ins that kill
working agents (flight-queue item 11, no recurrence in production since 09-28); the Playwright
quarantine (99 of 120 specs); the R2 orphaned-snapshot backfill (`01M40H4ZBTVC9WPNMRA5VMGPS9`);
and the AI-proxy token of agent processes alive past 24 h (`01M432G3276YZWCP3HEJ5B25J5`).

## Implementation checklist

- [x] Verify each of the 9 active files against its landing PR, the first successful production
      deploy, and (for flags) the deployed value; archive shipped files with a provenance footer
- [x] Add a dated status block to every active file that stays active
- [x] Delta-audit all 214 backlog files against this week's 26 merges (7 parallel read-only
      reviewers, line-balanced batches); fully audit the 8 files with no 2026-09-30 verdict
- [x] Remove backlog files only on a verified delete-class verdict; archive and repoint instead
      when anything that remains references the path
- [x] Add a `Reconciliation 2026-10-05` block to every file with new progress or a corrected fact
- [x] File a backlog entry for any bug the audit finds
- [x] Post a status nudge or park decision on #1788, #1817, #2020, #2062 and #2160
- [x] Record the full ledger here, then move this file to `tasks/archive/`

## Acceptance criteria

- [x] Every file left in `tasks/active/` has a measurably unmet acceptance criterion and live work:
      only the ProjectData emergency (9.72 GB against a 9.0 GB target).
- [x] Every archived file states how it shipped, and no box is ticked without evidence.
- [x] Every backlog removal has a one-line rationale in the PR description and in this ledger.
- [x] No citation in the repo points at a task path this PR moved or deleted.
- [x] Each open PR older than 7 days has a new 2026-10-05 comment.
- [x] The before/after file arithmetic closes exactly (see Outcome).
