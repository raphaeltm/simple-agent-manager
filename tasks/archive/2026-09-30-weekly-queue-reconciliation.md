# Weekly queue reconciliation — 2026-09-30

**SAM task:** `01M3RBQBHV39B9SHDC4BWBR16B`
**Branch:** `sam/weekly-queue-memory-reconciliation-wbr16b`
**Previous run:** `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`

## Problem

The repo's work-tracking surfaces drift from shipped reality. `/do` Phase 4 (archive the task
file) is still routinely skipped, so merged work sits in `tasks/active/`, and `tasks/backlog/`
collects entries that shipped, were superseded, or duplicate each other. A queue that lists
finished work as open makes it impossible to see what is genuinely open.

## Method

1. Built the evidence base: 1,945 merged and 210 closed-unmerged PRs; the commit that landed each
   task file; the first successful production deploy for each landing commit.
2. Audited `tasks/active/` by hand, including read-only production D1 queries where a verdict
   depended on an outcome rather than on code (day-7 task failures, stuck `destroying` nodes,
   ProjectData storage telemetry, archive breaker and migration states) and the GitHub
   `production` Environment variables where a verdict depended on a deployed value.
3. Audited all 300 `tasks/backlog/` files with ten parallel read-only reviewers, 30 files each.
   Each file was verified against the code in `main`, not against PR state. Verdicts: SHIPPED,
   SUPERSEDED, DUPLICATE, OBSOLETE, PARTIAL, OPEN, UNSURE. The rule was "when unsure, keep".
4. Removed a file only when its verdict was delete-class. If anything that remains in the repo
   (code, rules, archived tasks, surviving backlog entries) references it, the file was archived
   instead and the reference repointed. Otherwise it was deleted.
5. Narrowed every PARTIAL file with a dated status block (what shipped with evidence, what is
   still open). Duplicates were carried into their survivors before removal.
6. Independent local validators re-verified every removal against `main` (see the PR's
   Specialist Review Evidence).

## Outcome

| Directory                         | Before |     After |
| --------------------------------- | -----: | --------: |
| `tasks/active/`                   |     16 |     **1** |
| `tasks/backlog/`                  |    300 |   **208** |
| `tasks/archive/`                  |  1,118 | **1,159** |
| `tasks/completed/` (non-standard) |      2 |     **0** |

Before: 16 + 300 + 1,118 + 2 = 1,436. After: 1 + 208 + 1,159 = 1,368.
The difference is the new files (this ledger and one new backlog entry) minus the deleted
backlog files; the removal tables below list every one.

## Active: 16 → 1

Every active file reached `main` through its own implementation PR. Production has deployed
successfully through `main` HEAD (`2c009b565`, 02:19Z 2026-09-30), so every one of these PRs is live.
The first successful production deploy for each landing commit was matched from the Deploy
Production run history.

### Archived (14)

| File                                                   | Shipped by                           | First production deploy       | Boxes left unticked                                                   |
| ------------------------------------------------------ | ------------------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| `2026-09-23-model-catalog-refresh`                     | #2137 `9118dc306`                    | run 35931461373               | none                                                                  |
| `2026-09-24-modal-focus-steal-on-parent-rerender`      | #2154 `4ab3e20e2`                    | run 36282716394               | cogwheel entry point not separately staged                            |
| `2026-09-25-durable-wakes-must-wake`                   | #2148, #2145, #2155 `371801cce`      | run 36286553931               | workers vertical test not found; no surgical-revert evidence in #2155 |
| `2026-09-26-fix-flaky-worker-alarm-tests`              | #2156 `398fb92d6`                    | run 36280892213               | none                                                                  |
| `2026-09-26-terminal-node-cleanup-missing-provider-vm` | #2157 `8880c8761`                    | run 36294521255               | none                                                                  |
| `2026-09-27-fix-ghost-destroying-node-sweep`           | #2163 `0b33991ed`                    | run 36332601058               | none; prod D1: 5 → 0 `destroying` rows                                |
| `2026-09-27-fix-vm-admission-wakeup-user-filter`       | #2164 `e4434330b`                    | run 36342565618               | none                                                                  |
| `2026-09-27-normalize-platform-error-grouping`         | #2166 `9bbf4ea76`                    | run 36351810180               | none                                                                  |
| `2026-09-28-fix-instant-idle-sleep-wake-test-import`   | #2177 `a153d0bdb`                    | run 36505648204               | none                                                                  |
| `2026-09-28-instant-github-token-refresh`              | #2174 `397c6f2e5`                    | run 36505648204               | none (already all ticked)                                             |
| `2026-09-29-docs-update-weekly-ux-changes`             | #2179 `c17508d51`                    | run 36537657692               | none                                                                  |
| `2026-09-29-dormant-acp-interactions-foundation`       | #2182 `eaa01789d`, #2187 `7b6922ba5` | runs 36575465475, 36599006121 | Idea append could not land (Idea at the 64 KiB cap)                   |
| `2026-09-29-whole-session-resource-timeline`           | #2185 `2075aa074`                    | run 36638567882               | none                                                                  |
| `2026-09-29-working-set-resource-history`              | #2184 `c305c01c4`                    | run 36612733387               | none                                                                  |

Ticks were added only where a merged PR, a staging run, a production deploy, or a read-only
production D1 query proves the item. Everything else carries a `left unticked` note saying why.

### Moved back to backlog, narrowed (1)

`2026-09-26-trustworthy-task-status`. PR #2153 shipped the late-callback half. Its day-7
conversation fallback (`isHumanResumableConversationTask`,
`apps/api/src/services/task-sleep-preservation.ts:176`) joins a `session_snapshots` row with
`sleep_status = 'sleeping'`, which the 7-day purge deletes first. Read-only production D1 shows ten
conversation tasks failed with "Task runtime is no longer live after 480 minutes … workspace_deleted"
after the fix deployed, from 2026-09-27 02:36Z to 2026-09-30 02:36Z. No one is working it, so it
belongs in the backlog with a status block, not in `active/`.

### Kept active (1)

`2026-09-03-projectdata-production-capacity-emergency`, with a dated 2026-09-30 block:

- Root DO at 10,297,155,584 bytes (103%, `degraded`), up from 10,103,668,736 at last week's audit.
- SAM archive breaker `open` since 2026-09-27 16:47:58Z. The last SAM publish was 14:08:35Z that
  day; other projects had published 172 archives since, as of about 05:40Z.
- Migrations: 3 failed and 2 poisoned.
- The #2161 rollback trigger fired and was never acted on.
- Slice C code exists at `7868bc894` on the unmerged branch
  `sam/implement-reliable-projectdata-archiving-tc49jm`.

### Structural cleanup

- `tasks/completed/` held the two GitLab task files that PR #1578 meant to archive (both shipped
  2026-07-14). `tasks/archive/completed/` held one nested file from PR #1974. All three are now in
  `tasks/archive/`; the lifecycle has no `completed/` directory.
- One citation of a path this PR moved was repointed. Three older dangling `tasks/active/`
  references whose targets live in `tasks/archive/` were repointed too. Two references to files
  that only ever existed on branches were left alone as historical text.

## Open PRs older than seven days

Each of #1788, #1817, #2020 and #2062 had four bot comments in two weeks (09-16, 09-21, 09-23,
09-29) and no human reply. Each new comment says only what changed since 09-23 and the decision
that would end it.

| PR                                     |  Age | Behind `main` | Decision needed                                                                                   |
| -------------------------------------- | ---: | ------------: | ------------------------------------------------------------------------------------------------- |
| #1817 architecture workspace prototype | 47 d |           657 | Close (capture as an Idea) or commit to re-cutting as slices                                      |
| #2020 SonarQube Cloud coverage         | 25 d |           199 | `SONAR_TOKEN`, disable Automatic Analysis, set `SONAR_CI_ENABLED`; the CodeRabbit concern is gone |
| #2062 sleep-progress moon asset        | 18 d |           153 | One product call: show an animated moon, and where                                                |
| #1788 scheduled OSV scan               | 50 d |           669 | Build the private intake, or drop scheduled OSV scanning                                          |

## Found during the audit

- **`update_idea` silently discards appends at the 65,536-character cap.** Filed as
  `tasks/backlog/2026-09-30-update-idea-append-silently-truncated-at-cap.md`. Four SAM Ideas are
  already at the cap. The two live ones now carry a "FULL at 64 KiB" title marker.
- **The #1468 reorganization (2026-07-02) moved about 26 already-implemented files from `active/`
  back to `backlog/` unchecked.** Most of this week's shipped removals are those files.
- **Two public blog posts describe branch-only harness features as shipped**:
  `sams-journal-three-models-one-gateway.md:49-57` and
  `sams-journal-the-harness-leaves-the-laptop.md:48-49`. The work lives on the idle
  `origin/harness/develop`. This is recorded on the narrowed harness phase-1 file.
- **The Playwright audit corpus is mostly quarantined.** 99 of 115 specs are quarantined, so the
  clipped-overflow guard blocks nothing in CI. This is consolidated under
  `2026-07-17-stale-playwright-audit-specs`, and `2026-09-23-playwright-audit-shell-mocks-crash` is
  the root-cause fix to do first.
- **Undefined design tokens.** `text-fg-secondary` maps to no token and is used in 24 `apps/web`
  files. It is folded into the retitled `2026-09-23-resource-sparkline-gap-marker-has-no-colour`
  file, now "Undefined --sam-color-* tokens in apps/web".

## Backlog

### Verdict tally (300 files audited)

| Verdict         | Files |
| --------------- | ----: |
| OPEN            |   101 |
| PARTIAL         |   101 |
| SHIPPED         |    59 |
| OBSOLETE        |    15 |
| SUPERSEDED      |    11 |
| UNSURE          |     4 |
| DUPLICATE       |     4 |
| SHIPPED-ARCHIVE |     3 |
| DISSOLVE        |     1 |
| MERGE           |     1 |

### Deleted (nothing that remains references them): 70

| File                                                       | Verdict    | Conf. | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ---------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-02-20-dashboard-chat-session-navigation`             | superseded | high  | Spec 017 paused; /chats page (#574) + dashboard active tasks (#2152) deliver the user stories                                                                                                                                                                                                                                                                                                                                             |
| `2026-02-20-mobile-navbar-redesign`                        | shipped    | med   | #137 (c58ca2244): MobileNavDrawer.tsx, compact UserMenu, z-index tokens + tests                                                                                                                                                                                                                                                                                                                                                           |
| `2026-02-23-admin-page-padding`                            | shipped    | high  | Admin.tsx:35 uses PageLayout (#176)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `2026-02-23-loading-state-pattern`                         | shipped    | high  | #176 fixed all 8 guards; principle codified as apps/web rule 48                                                                                                                                                                                                                                                                                                                                                                           |
| `2026-02-23-tasks-tab-filter-layout`                       | shipped    | high  | TaskFilters.tsx:33-74 flex-wrap row (#176)                                                                                                                                                                                                                                                                                                                                                                                                |
| `2026-02-27-tdf-0-index`                                   | shipped    | high  | All TDF parts merged (#210, #212-#219); index obsolete                                                                                                                                                                                                                                                                                                                                                                                    |
| `2026-02-27-tdf-3-node-selection-provisioning`             | shipped    | high  | #213 tests shipped; node-selector.ts later replaced by task-runner/node-selection.ts (#2030)                                                                                                                                                                                                                                                                                                                                              |
| `2026-02-27-tdf-4-vm-agent-contract`                       | shipped    | high  | #214/#215: packages/shared/src/vm-agent-contract.ts + TS/Go contract tests + callbackretry                                                                                                                                                                                                                                                                                                                                                |
| `2026-02-27-tdf-5-workspace-lifecycle`                     | shipped    | high  | /ready and /provisioning-failed call TaskRunner directly (lifecycle.ts:574,644); spec 033                                                                                                                                                                                                                                                                                                                                                 |
| `2026-02-27-tdf-6-chat-session-management`                 | shipped    | high  | #216: required session creation, no sess-fallback, linkSessionToWorkspace, VM outbox retry                                                                                                                                                                                                                                                                                                                                                |
| `2026-02-27-tdf-7-recovery-resilience`                     | shipped    | high  | #217: stuck-tasks.ts diagnostics + layered orphan sweeps + tests                                                                                                                                                                                                                                                                                                                                                                          |
| `2026-02-27-tdf-8-frontend-state-tracking`                 | shipped    | high  | #218: EXECUTION_STEP_LABELS, ProvisioningIndicator, reconnect/catch-up                                                                                                                                                                                                                                                                                                                                                                    |
| `2026-02-28-project-agent-type-setting`                    | shipped    | high  | #295: schema.ts:425, project-update.ts, ProjectSettings.tsx; precedence explicit->profile->project                                                                                                                                                                                                                                                                                                                                        |
| `2026-03-02-fix-admin-logs-query-error`                    | shipped    | high  | #298 (983f00a0f) restructured the query body (services/observability.ts:612-640); regression tests observability-logs.test.ts:168-215,431; #1468 reorg moved the file back to backlog unchecked                                                                                                                                                                                                                                           |
| `2026-03-02-quick-workspace-launch-ux`                     | obsolete   | med   | ProjectOverview.tsx (Launch Workspace) deleted in #466; chat is task-driven and #1977 made workspaces an implementation detail                                                                                                                                                                                                                                                                                                            |
| `2026-03-05-agent-session-not-found-404`                   | obsolete   | med   | Retry path now re-runs idempotent create then start (agent-session-bootstrap.ts:233,289-371); replay after restart fails closed with 409; crash loop fixed in #293                                                                                                                                                                                                                                                                        |
| `2026-03-06-acp-session-message-persistence`               | shipped    | high  | #314 (383e652b8) gave every SessionHost the message reporter (agent_ws.go:278-287); #270 follow-ups persist; DO dedupe (messages.ts:199-236); #978 DO-only chat                                                                                                                                                                                                                                                                           |
| `2026-03-06-continue-staging-ux-ui-qa`                     | obsolete   | med   | Continuation of one interrupted 2026-03-05 QA session against what is now production; flows rebuilt; per-PR staging + Playwright audits now mandatory                                                                                                                                                                                                                                                                                     |
| `2026-03-06-project-chat-acp-503-on-new-workspace`         | obsolete   | high  | #978 removed the client ACP WebSocket from project chat (the path that raced DNS)                                                                                                                                                                                                                                                                                                                                                         |
| `2026-03-07-chat-continuation-after-workspace-cleanup`     | superseded | high  | #1785 snapshot sleep/wake (tasks/archive/2026-08-12-persistent-session-sleep-wake.md) + fork (routes/chat-fork.ts)                                                                                                                                                                                                                                                                                                                        |
| `2026-03-08-fix-acp-session-context-loss-on-followup`      | shipped    | high  | Cause 1 #1099 (LoadSession on restart, tests session_host_crash_recovery_test.go:317-392); cause 2 #386 guard + #978; cause 3 sleep/wake #1785                                                                                                                                                                                                                                                                                            |
| `2026-03-09-fix-node-workspace-limit-count-filters`        | shipped    | high  | #290 (ffe0092e2) status filters + tests (nodes-max-nodes-quota.test.ts, node-provisioning.test.ts); per-node cap removed in #2149                                                                                                                                                                                                                                                                                                         |
| `2026-03-13-workspace-profile-ui-ux-improvements`          | obsolete   | high  | SettingsDrawer.tsx deleted (#1131); TaskSubmitForm.tsx unused by production routes; profile control is now a SelectField                                                                                                                                                                                                                                                                                                                  |
| `2026-03-15-dialog-focus-trap`                             | shipped    | high  | useModalInteraction.ts:118-170 Tab wrap + restore; Dialog.tsx:46; packages/ui/tests/Dialog.test.tsx:125,149,214 (#1637, #2154)                                                                                                                                                                                                                                                                                                            |
| `2026-03-15-scroll-to-bottom-button`                       | shipped    | high  | #411: ConversationPane.tsx:136,153-167 (atBottom toggle, aria-label); overlap fixed #519; the file itself says archive                                                                                                                                                                                                                                                                                                                    |
| `2026-03-16-notification-system-phase1-followups`          | dissolved  | high  | Umbrella file; shipped parts (workerd DO tests, type tabs #973, 90-day TTL) done; unique open items moved into the security, UI/a11y and test-gap siblings                                                                                                                                                                                                                                                                                |
| `2026-03-17-port-proxy-ownership-verification`             | merged     | high  | Ownership + 401 via #928/#936 and per-port token (jwt.ts:330-400) shipped; unique items carried into port-exposure-security-hardening                                                                                                                                                                                                                                                                                                     |
| `2026-03-18-mcp-json-session-cleanup`                      | obsolete   | high  | workspace_mcp.go deleted in #614 (8bb1324b4); nothing writes .mcp.json any more                                                                                                                                                                                                                                                                                                                                                           |
| `2026-03-19-ideas-page-polish`                             | obsolete   | high  | All 3 targeted surfaces redesigned away (idea detail page #473; sidebar pills removed #885; status select removed #1263)                                                                                                                                                                                                                                                                                                                  |
| `2026-03-19-scroll-button-cancel-button-overlap`           | shipped    | high  | #519 offset fix; cancel strip later replaced by CompletionDock (#1474)                                                                                                                                                                                                                                                                                                                                                                    |
| `2026-03-23-task-callback-scope-enforcement`               | shipped    | high  | routes/tasks/callback.ts:77 requires expectedScope 'workspace' (enforced services/jwt.ts:277); tests task-callback-auth-routing.test.ts:353, callback-token-unified-scope.test.ts:49                                                                                                                                                                                                                                                      |
| `2026-03-24-gcp-oidc-ux-fixes`                             | shipped    | high  | #511: loading-projects phase, ConfirmDialog, tests + Playwright spec; SettingsDrawer item moot (#1131)                                                                                                                                                                                                                                                                                                                                    |
| `2026-03-24-remove-legacy-node-callback-fallback`          | shipped    | high  | #674 removed the nodeId fallback (verifyWorkspaceCallbackAuth, _helpers.ts:357-396); tests callback-token-scope-enforcement.test.ts:74-102                                                                                                                                                                                                                                                                                                |
| `2026-03-28-files-go-shell-injection-defense`              | shipped    | high  | #651 removed sh -c/head -n; find runs with direct args (files.go:78-81); test files_test.go:11                                                                                                                                                                                                                                                                                                                                            |
| `2026-03-31-pr570-remaining-test-doc-gaps`                 | obsolete   | high  | #733 (83bdc3e49) deleted the whole Neko sidecar these items target                                                                                                                                                                                                                                                                                                                                                                        |
| `2026-04-09-reconnect-button-behavioral-test`              | obsolete   | high  | AgentErrorBanner and its Reconnect button deleted in #978 (ef889afb4)                                                                                                                                                                                                                                                                                                                                                                     |
| `2026-04-13-knowledge-graph-ui-accessibility`              | obsolete   | high  | KnowledgePage.tsx deleted in #1137; replacement MemoryTab.tsx already has the key fixes                                                                                                                                                                                                                                                                                                                                                   |
| `2026-04-18-multi-level-configuration-override`            | shipped    | high  | #748 (c32e5733d) from this file's own branch: migration 0042, schema.ts:434, project-update.ts:162-183, dispatch-tool.ts, ProjectAgentsSection.tsx, tests/unit/project-agent-defaults.test.ts; #1468 moved it back to backlog                                                                                                                                                                                                             |
| `2026-04-18-nested-chat-sidebar-tree`                      | superseded | high  | Tree shipped in #759 then deliberately replaced by a flat list + hierarchy modal in #1287 (sessionTree.ts deleted); design in archived 2026-06-10/11 hierarchy tasks                                                                                                                                                                                                                                                                      |
| `2026-04-18-staging-migration-v8-corruption`               | obsolete   | high  | v8 is a DO migration tag; #1649 resolver reads the deployed tag and fails closed on unknown tags; 7 of the last 8 staging deploys succeeded                                                                                                                                                                                                                                                                                               |
| `2026-04-18-trial-onboarding-wave-0-foundation`            | shipped    | high  | All items in e253c08ea via #758: packages/shared/src/trial.ts, 0043_trial_foundation.sql, schema.ts:3326-3336, wrangler bindings, constant-time compare, routes, tests                                                                                                                                                                                                                                                                    |
| `2026-04-23-expose-platform-opencode-in-project-chat`      | obsolete   | high  | Shipped in #1051 then intentionally removed in #1431 (OpenCode is bring-your-own-key only; agents-catalog.ts:12)                                                                                                                                                                                                                                                                                                                          |
| `2026-04-25-mcp-token-refresh-for-long-sessions`           | shipped    | high  | Sliding window + 24h cap (mcp-token.ts:109-161, defaults.ts:292) with tests mcp-token-sliding-window.test.ts (6017aea57, #966)                                                                                                                                                                                                                                                                                                            |
| `2026-04-29-session-header-agent-info-mobile-fixes`        | shipped    | high  | All findings fixed in #856 squash (bdaba5376): SessionHeader.tsx:413-438, session.ts:31, tests + audit spec                                                                                                                                                                                                                                                                                                                               |
| `2026-04-30-vm-agent-workspace-provisioning-queue`         | shipped    | high  | #2030 (1d21cb8e1): system-provisioning barrier (system_provisioning.go, main.go:251-268) with tests                                                                                                                                                                                                                                                                                                                                       |
| `2026-05-01-monthly-cost-cap-enforcement`                  | shipped    | high  | #1060 + #1420: ai-monthly-cost-cron.ts + gate in ai-token-budget.ts:602-656 called from every proxy path, with tests                                                                                                                                                                                                                                                                                                                      |
| `2026-05-01-tail-worker-log-ingest-auth`                   | shipped    | high  | #890 (d74b178fd): internal-hostname gate in routes/observability-ingest.ts with tests; duplicate of archived 2026-05-04-fix-tail-worker-ingest-auth.md                                                                                                                                                                                                                                                                                    |
| `2026-05-07-convert-eval-backlog-to-task-packets`          | obsolete   | med   | Packet PR #924 closed unmerged; source docs/evaluations folder deleted in #1174; findings 5 months stale                                                                                                                                                                                                                                                                                                                                  |
| `2026-05-07-unblock-pr-927-ci-fixes`                       | shipped    | high  | PR #927 merged 2026-05-08 (0ba546965) with every fix (ci.yml:526-527, playwright.config.ts, sonar-project.properties)                                                                                                                                                                                                                                                                                                                     |
| `2026-05-08-project-agent-tools-import-timeout`            | shipped    | high  | All boxes ticked; PROJECT_AGENT_TOOLS_IMPORT_TIMEOUT_MS at project-agent.test.ts:12 (#932)                                                                                                                                                                                                                                                                                                                                                |
| `2026-05-12-prevent-duplicate-workspace-dispatch`          | shipped    | high  | #1033 (migration 0050 dispatched_at, node-lifecycle.ts:220-252) + #1031; twin of archived 2026-05-16-workspace-dispatched-at-race.md                                                                                                                                                                                                                                                                                                      |
| `2026-05-15-session-icon-mode-enrichment`                  | shipped    | high  | All ticked; #1020 (e8e81b4bc) + session-icon-data-flow.test.tsx                                                                                                                                                                                                                                                                                                                                                                           |
| `2026-05-15-vertical-slice-cron-triggers`                  | shipped    | high  | #1017 (aa804c773): workers cron-trigger-sweep.test.ts + trigger-execution-cleanup.test.ts                                                                                                                                                                                                                                                                                                                                                 |
| `2026-05-15-vertical-slice-tests-background-jobs`          | shipped    | high  | #1017: workers scheduled-*.test.ts suites + seed-d1 fixtures                                                                                                                                                                                                                                                                                                                                                                              |
| `2026-05-16-mobile-viewport-scroll-regression`             | shipped    | med   | #1044 ee6169c05 scoped overflow:hidden to desktop (index.css:40-49) + mobile-viewport.ts; real-device check not verifiable from code                                                                                                                                                                                                                                                                                                      |
| `2026-05-17-session-state-mirror`                          | shipped    | high  | #1043 (66a7f6c3d) and extensions: session_host_reporting.go, project-data/session-state.ts, session-state-mirror.test.ts                                                                                                                                                                                                                                                                                                                  |
| `2026-05-30-ai-usage-audit-route-drift`                    | duplicate  | high  | Same spec + failures are row 16 of 2026-07-17-stale-playwright-audit-specs.md (survivor); carry the root-cause correction (headings still exist; render after compute usage loads)                                                                                                                                                                                                                                                        |
| `2026-05-30-github-event-triggers-prototype`               | shipped    | high  | Shipped for real as #1160 (c444b3e05): migration 0057, github-trigger-filter.ts, webhook handler, UI, kill switch, tests                                                                                                                                                                                                                                                                                                                  |
| `2026-05-31-resource-override-audit-slice`                 | superseded | high  | Overtaken by shipped compute-pools placement (#2030; resource-requirements-input.ts layer order; placement-resolver.ts; resolved_reservation_json)                                                                                                                                                                                                                                                                                        |
| `2026-06-06-light-mode-slice-c-workspace-node-detail`      | superseded | high  | Superseded by consolidated light-mode PR #1239 (archived twin 2026-06-06-light-mode-slice-c-workspace-chrome.md)                                                                                                                                                                                                                                                                                                                          |
| `2026-06-07-cache-user-installation-repos-spawn-hot-path`  | shipped    | med   | d1a7380e3: KV cache in assertRepositoryAccess (routes/projects/_helpers.ts:258-289) keyed by user+installation+repo, GITHUB_REPO_ACCESS_CACHE_TTL_SECONDS (default 300s), used by run/submit/workspace-create/chat-start; tests project-repository-access.test.ts:111-175; note: the default TTL is 300 s where the task suggested ~60 s (env-configurable, no production override), and the drift 403 check still runs on cached results |
| `2026-06-08-fix-cancel-replays-conversation`               | shipped    | high  | #1254 (f33a95c3f): replaySuppressed field (session_host.go:204-210), deferred clear (session_host_handshake.go:113-114), early return (session_host_client.go:52); tests session_host_replay_suppress_test.go:59,203                                                                                                                                                                                                                      |
| `2026-06-18-deployment-node-observability`                 | shipped    | high  | #1356 (703b8b56f): container log reading/streaming (logreader/docker.go, stream.go), deployment-environments routes, DeploymentMetricsPanel, DeploymentLogsPanel, container picker; Go/TS/Playwright tests                                                                                                                                                                                                                                |
| `2026-08-04-chat-file-viewer-audit-spec-broken`            | duplicate  | high  | Same spec and symptom as the chat-file-viewer row in 2026-07-17-stale-playwright-audit-specs (survivor); carry #1976 retarget note                                                                                                                                                                                                                                                                                                        |
| `2026-08-06-configure-remaining-debugging-safety-bounds`   | shipped    | high  | #1750 (a857a337e) shipped all four bounds (config_load.go:302-304, errorreport, VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES, cloud-init wiring) with tests and docs; no references outside tasks/                                                                                                                                                                                                                                                |
| `2026-08-11-project-chat-recoverable-error-banner-missing` | superseded | med   | Banner replaced by FailureCard; spec rewritten (#1839) and quarantined; folded into 2026-07-17-stale-playwright-audit-specs with the guidance-text assertion                                                                                                                                                                                                                                                                              |
| `2026-08-11-scaling-settings-audit-spec-stale`             | duplicate  | med   | Same failure is a row in 2026-07-17-stale-playwright-audit-specs:18 (survivor); spec quarantined at line 92                                                                                                                                                                                                                                                                                                                               |
| `2026-08-11-useprojectlist-options-not-forwarded`          | obsolete   | high  | 6f0912209 (via #1839) removed status/sort from useProjectList; now TanStack-based                                                                                                                                                                                                                                                                                                                                                         |
| `2026-08-17-recover-rebase-land-harness-work-sleep-fix`    | shipped    | high  | PR #1845 (855f701e3) merged the recovered branch: migrations 030/031, wait_for_subtasks, docs, idea 01M07SW32WP8ZXABWF1ZV3AEMX filed                                                                                                                                                                                                                                                                                                      |
| `2026-09-29-chat-page-404s-on-deleted-session-workspace`   | duplicate  | high  | Same code path as 2026-09-08-ended-chat-requests-deleted-workspace (survivor); carry the 09-29 staging repro                                                                                                                                                                                                                                                                                                                              |

### Archived instead of deleted (still referenced; paths repointed): 24

| File                                                           | Verdict    | Conf. | Evidence                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2026-02-15-user-configurable-mcp-servers`                     | superseded | high  | Shipped as BYO MCP servers (#1892, #2186; mcp_connections schema.ts:2069; SettingsMcpServers.tsx); survivor tasks/archive/2026-08-23-byo-mcp-servers.md; file already bannered "SUPERSEDED, do not execute"                                                                          |
| `2026-02-28-fix-flaky-vm-agent-tests`                          | superseded | high  | Survivor tasks/backlog/2026-07-04-fix-flaky-tests-at-root.md (item 3 says this file's root cause is wrong)                                                                                                                                                                           |
| `2026-02-28-mobile-chat-ux-overhaul`                           | shipped    | high  | #220: AppShell mobile header, MobileSessionDrawer, full-bleed chat                                                                                                                                                                                                                   |
| `2026-03-06-unify-project-chat-through-do-streaming`           | superseded | high  | #978 / tasks/archive/2026-05-12-do-only-chat-typewriter.md: all chat through the DO with typewriter rendering                                                                                                                                                                        |
| `2026-03-09-quick-chat-mode-design`                            | shipped    | high  | Design-only task, all 5 criteria checked; approaches since built (sam-session DO, project-agent, Instant sessions)                                                                                                                                                                   |
| `2026-03-12-provisioning-failed-callback-401`                  | shipped    | high  | #325 (9c7875b8c) same-day fix; route uses callback JWT only (lifecycle.ts:580-583); tests workspace-callback-auth-routing.test.ts:157,202                                                                                                                                            |
| `2026-03-14-fix-mistral-vibe-acp-metadata`                     | shipped    | high  | #386 (c3a190e7d): ACP ClientInfo + VIBE_CLIENT_* (gateway.go:1136-1142) and generated ~/.vibe/config.toml aliases (vibe_config.go:45-143)                                                                                                                                            |
| `2026-03-18-docker-exec-env-token-exposure`                    | shipped    | high  | #516 (0cd0fc6e8): /dev/shm 0600 --env-file (process.go:127-160,276-309); tests process_test.go:160-214 assert secrets never in args                                                                                                                                                  |
| `2026-04-02-fix-codex-mcp-streamable-http-compliance`          | superseded | high  | Shipped as PR #601 under tasks/archive/2026-04-03-fix-mcp-streamable-http-compliance.md                                                                                                                                                                                              |
| `2026-04-11-fix-flaky-useAvailableCommands-test`               | superseded | high  | Proposed fix landed (25f329b88, #694); root cause owned by tasks/backlog/2026-07-04-fix-flaky-tests-at-root.md, which says to archive this file                                                                                                                                      |
| `2026-05-05-debug-package-fixes`                               | shipped    | med   | All seven fix groups landed via #901 (template.ts mirror script, 15-min timeout), #966 (callback 401 + logged bodies), #1010 (cloud-init schema), VERSION pinned in deploy-reusable.yml:1057                                                                                         |
| `2026-05-05-fix-chat-message-loading-regression`               | shipped    | high  | #898 did every item; the 3000 default was deliberately replaced by paging in #2165                                                                                                                                                                                                   |
| `2026-05-12-fix-vm-agent-stability`                            | shipped    | high  | Timers #968, dispatch dedup #1033 + VM idempotency #1031, callback extraction + MCP sliding window #966                                                                                                                                                                              |
| `2026-05-12-vm-agent-cloud-init-firewall-hygiene`              | shipped    | high  | #968 (cbd2ad1d3): template.ts:35-39, :632-650; tests generate.test.ts:1486-1508,1548-1570                                                                                                                                                                                            |
| `2026-05-27-workspace-forward-local-port-remap`                | shipped    | high  | #1370 (2686df375) added --local-port (workspace.go:151-164,233-254) with tests                                                                                                                                                                                                       |
| `2026-06-13-compose-preview-endpoint-route-targets`            | shipped    | high  | #1312 (8ccbcee41): deployment-releases.ts:353-376 passes routeTargets matching the apply payload; tests compose-preview-parity.test.ts:110,158,231                                                                                                                                   |
| `2026-06-13-deployment-per-env-host-port-offset`               | shipped    | med   | #1312: per-environment port band (deployment-routing.ts:71-100) + teardown-before-start (engine.go:255-275); tests deployment-routing.test.ts, TestEngine_RedeployPortRebind; residual 1-in-305 band collision risk tracked in 2026-06-17-deploy-engine-security-hardening-followups |
| `2026-08-07-staging-vm-agent-no-heartbeat-before-workspace`    | obsolete   | med   | Fresh staging VMs have heartbeated repeatedly since (archived 2026-08-09, 2026-09-08, 2026-09-25 evidence); symptom never recurred                                                                                                                                                   |
| `2026-08-25-build-concurrency-backpressure`                    | shipped    | high  | PR #1904 (1d7fab947): build semaphore server.go:583, creatingWorkspaces health.go:169, build-started callback, TaskRunner reset, TS+Go tests; cited by scaling.ts:69 and generate.test.ts:560 -> archive + repoint                                                                   |
| `2026-08-26-stop-zombie-callback-storms`                       | shipped    | high  | PR #1922 (01a827015): 410 for tombstoned nodes, JWT 401s, vm-agent terminal latch, MSG_RESPONSE_MAX_BYTES; staging evidence in file; cited by an archived task -> archive                                                                                                            |
| `2026-09-05-archive-precopy-refusal-should-not-fence-session`  | shipped    | high  | Folded into and shipped by PR #2027 (refusePreCopyMigration + restoreSessionLocationToRootStatement, project-data-archive-sharding.ts:2127,2171; tests :2753,:2910); leftover session_state decision lives in idea 01M1V3WYT6D88Z41WQWP0ASVC3                                        |
| `2026-09-19-deployment-provisioning-expression-tree-too-large` | shipped    | high  | Resolved in PR #2102 (all criteria ticked with staging evidence); regression test tests/workers/deployment-provisioning-expression-depth.test.ts; resolved record -> move to archive                                                                                                 |
| `2026-09-25-timing-sensitive-workers-tests`                    | shipped    | high  | PR #2156 fixed both named tests (reserved-task-submission-task-runner.test.ts:83/:704; project-data-storage-safety.test.ts:61/:1688); #2158 helper                                                                                                                                   |
| `2026-09-26-split-use-session-lifecycle`                       | shipped    | high  | PR #2165 (77372abba) took useSessionLifecycle.ts 787 -> 489 lines (useSessionTranscript.ts, useFallbackSessionPoll.ts)                                                                                                                                                               |

### Kept and narrowed (status block added): 101

- `2026-02-16-sidebar-redesign-tier2`
- `2026-02-17-persistent-terminal-sessions`
- `2026-02-17-vm-log-browser`
- `2026-02-20-acp-session-error-observability`
- `2026-02-20-orphaned-session-detection-and-recovery`
- `2026-02-24-vm-agent-process-lifecycle-and-stability`
- `2026-02-27-tdf-1-task-state-machine`
- `2026-03-03-improve-test-infrastructure`
- `2026-03-03-simplify-deploy-scripts-and-infra`
- `2026-03-03-simplify-durable-objects-and-schema`
- `2026-03-03-simplify-shared-packages`
- `2026-03-03-simplify-web-app-components`
- `2026-03-03-task-completion-lifecycle`
- `2026-03-04-system-reliability-and-maintainability-hardening`
- `2026-03-07-research-chat-truncation-causes`
- `2026-03-13-binary-install-security-hardening`
- `2026-03-13-scaleway-provider-improvements`
- `2026-03-13-wire-provider-env-var-overrides`
- `2026-03-14-fork-dialog-ui-polish`
- `2026-03-14-unified-session-task-workspace-state-machine`
- `2026-03-16-compute-lifecycle-test-gaps`
- `2026-03-16-mcp-page-size-limits-not-configurable`
- `2026-03-16-notification-phase2-perf-followups`
- `2026-03-16-notification-security-followups`
- `2026-03-16-notification-test-coverage-gaps`
- `2026-03-16-notification-ui-accessibility-followups`
- `2026-03-16-port-exposure-security-hardening`
- `2026-03-17-acp-subagent-idle-detection`
- `2026-03-18-fix-git-identity-conversation-mode`
- `2026-03-18-workspace-mcp-server-p2`
- `2026-03-19-graph-execution-model`
- `2026-03-19-virtual-scrolling-test-coverage-gaps`
- `2026-03-24-deployment-settings-ui-fixes`
- `2026-03-28-migrate-file-proxy-token-to-auth-header`
- `2026-04-01-replace-source-contract-tests`
- `2026-04-09-trigger-api-optimizations`
- `2026-04-10-route-level-error-message-leakage`
- `2026-04-10-web-lazy-loading-error-boundaries-a11y`
- `2026-04-13-knowledge-graph-hardening`
- `2026-04-13-knowledge-graph-test-coverage`
- `2026-04-18-agent-key-card-accessibility`
- `2026-04-18-credentials-miniflare-integration-tests`
- `2026-04-18-multi-level-override-framework`
- `2026-04-18-project-credentials-followups`
- `2026-04-18-project-credentials-missing-tests`
- `2026-04-19-trial-late-audit-hardening`
- `2026-04-19-trial-orchestrator-boot-test-coverage-gaps`
- `2026-04-19-trial-orchestrator-step-handler-coverage`
- `2026-04-22-infrastructure-nav-and-platform-infra-admin`
- `2026-04-23-deploy-script-security-hardening`
- `2026-04-23-remove-docker-requires-from-vm-agent-systemd`
- `2026-04-24-session-header-a11y-token-fixes`
- `2026-04-26-durable-interrupts-test-gaps`
- `2026-04-27-sam-tools-post-review-improvements`
- `2026-04-30-unified-user-usage-stats`
- `2026-05-01-ai-proxy-credential-hardening`
- `2026-05-01-wp6-playwright-visual-audit`
- `2026-05-03-harness-phase1-capable-coding-agent`
- `2026-05-06-compact-mode-test-coverage-gaps`
- `2026-05-10-lifecycle-state-accuracy`
- `2026-05-11-duplicate-task-session-finalization`
- `2026-05-20-amp-project-chat-mcp-wiring`
- `2026-06-04-error-node-cleanup`
- `2026-06-06-library-ui-a11y-preexisting`
- `2026-06-07-leak-sweep-test-coverage-gaps`
- `2026-06-08-same-org-submodule-repo-access`
- `2026-06-11-compose-parser-test-coverage`
- `2026-06-12-deployment-provisioning-route-tests`
- `2026-06-12-timeline-drawer-post-merge-fixes`
- `2026-06-15-alternative-inference-providers-backend`
- `2026-06-17-deploy-engine-security-hardening-followups`
- `2026-06-18-deploy-day2-ops-followups`
- `2026-06-18-vm-agent-lifecycle-idempotent-shutdown`
- `2026-06-24-compose-publish-x-sam-routes`
- `2026-07-04-fix-flaky-tests-at-root`
- `2026-07-12-cf-container-wake-restore-hardening`
- `2026-07-16-project-data-row-fault-isolation-audit`
- `2026-07-17-stale-playwright-audit-specs`
- `2026-07-19-instant-launch-stuck-queued-on-disconnect`
- `2026-07-19-instant-session-capacity-controls`
- `2026-07-19-repo-history-bloat-cleanup`
- `2026-07-20-instant-ping-container-died-midsession`
- `2026-07-23-credential-routes-preexisting-hardening`
- `2026-08-03-durable-follow-up-prompt-delivery`
- `2026-08-04-flaky-vultr-ip-poll-error-test`
- `2026-08-04-shared-staging-do-migration-pinning`
- `2026-08-06-digitalocean-vultr-pagination-silent-truncation`
- `2026-08-06-harden-vm-incident-callback-lifecycle-binding`
- `2026-08-06-isolate-standalone-agent-process-environment`
- `2026-08-06-reconciliation-dead-target-task-status-events`
- `2026-08-06-run-gate-ignores-platform-cloud-credential`
- `2026-08-07-durable-background-vm-provisioning`
- `2026-08-07-expand-frontend-query-cache-and-persistence`
- `2026-08-07-fix-stuck-task-sweep-pattern-complexity`
- `2026-08-08-debugging-overhaul-review-followups`
- `2026-08-11-vm-agent-snapshot-degradation-union-mismatch`
- `2026-08-18-consolidate-hand-rolled-visibility-polls`
- `2026-09-08-staging-repeated-noop-storage-alarms`
- `2026-09-19-volume-status-badge-and-create-time-status`
- `2026-09-23-resource-sparkline-gap-marker-has-no-colour`
- `2026-09-25-split-permanent-session-recovery-refusals`

### Kept as open: 101

- `2026-02-15-vm-agent-in-place-binary-update`
- `2026-02-16-additional-cloud-providers`
- `2026-02-20-acp-reconnect-replay-integration-test`
- `2026-02-20-agent-session-startup-optimization`
- `2026-02-23-worktree-redesign`
- `2026-02-28-mobile-nav-dropdown-menus`
- `2026-03-03-simplify-vm-agent-architecture`
- `2026-03-09-fix-task-status-display`
- `2026-03-09-llm-task-prioritization`
- `2026-03-10-log-viewer-test-coverage-gaps`
- `2026-03-12-bootstrap-token-dual-auth-dead-code`
- `2026-03-14-summarize-endpoint-hardening`
- `2026-03-15-agent-profiles-4-system-prompt-injection`
- `2026-03-17-dispatch-push-parent-branch`
- `2026-03-17-mcp-token-do-storage-security`
- `2026-03-18-code-context-for-task-submission`
- `2026-03-18-gcp-self-hosting-docs`
- `2026-03-19-chat-view-transitions`
- `2026-03-19-mcp-notification-waituntil`
- `2026-03-28-file-raw-security-hardening`
- `2026-03-29-vm-agent-read-header-timeout`
- `2026-03-30-account-map-db-indexes`
- `2026-03-30-enforce-per-project-task-execution-timeout`
- `2026-04-03-split-oversized-files`
- `2026-04-08-credential-helper-per-workspace-directory`
- `2026-04-09-document-heartbeat-acp-sweep`
- `2026-04-10-git-show-colon-refspec-injection`
- `2026-04-12-credential-validity-quota-bypass`
- `2026-04-12-devcontainer-config-secondary-paths`
- `2026-04-18-project-credentials-playwright-audit`
- `2026-04-19-trial-sse-abort-propagation`
- `2026-04-19-trial-sse-cursor-persistence`
- `2026-04-20-platform-trial-enabled-env-var`
- `2026-04-24-library-like-escape-clause`
- `2026-05-01-fix-playwright-desktop-test-infrastructure`
- `2026-05-01-wp6-openai-routing-integration-test`
- `2026-05-03-harness-phase2-sam-platform-integration`
- `2026-05-19-error-banner-role-alert`
- `2026-05-26-encrypted-swap-cloud-init`
- `2026-06-03-tts-phase-benchmark`
- `2026-06-06-projectlibrary-rule18-split`
- `2026-06-07-theme-switcher-playwright-coverage-gaps`
- `2026-06-09-git-credential-loopback-container-binding`
- `2026-06-09-git-credential-node-token-fallback-hardening`
- `2026-06-18-api-composition-root-extraction`
- `2026-06-18-vm-agent-bootstrap-pipeline`
- `2026-06-20-agent-crash-loop-kitty-keyboard-escape`
- `2026-06-26-admin-user-resource-overview`
- `2026-07-12-gitlab-token-lock-rate-limit`
- `2026-07-12-multi-installation-cloudflare-namespaces`
- `2026-07-16-observability-mcp-outcome-parsing-gap`
- `2026-07-19-split-env-interface`
- `2026-07-21-extend-stale-instant-callback-guard-coverage`
- `2026-07-21-instant-container-request-timeout-cancellation`
- `2026-07-21-project-invite-role-and-link-gaps`
- `2026-07-21-remove-sandbox-env-fallbacks-from-container-runtime`
- `2026-07-23-byo-phase0-review-followups`
- `2026-07-23-vultr-onboarding-wizard-parity`
- `2026-07-25-admin-ai-proxy-orphaned-default-model`
- `2026-07-25-translate-proxy-sampling-params-4-7-plus`
- `2026-07-29-observability-info-events-persisted-as-errors`
- `2026-08-04-auto-commit-push-guard-false-positive-manual-workspaces`
- `2026-08-04-instant-persistence-step-renders-as-provisioning-vm`
- `2026-08-04-report-issue-length-env-vars-cannot-raise-limits`
- `2026-08-04-sleeping-status-renders-as-unknown`
- `2026-08-06-investigate-orphaned-projectdata-alarm-wall-time`
- `2026-08-06-project-orchestrator-cancel-status-events`
- `2026-08-06-wrangler-sync-env-parity-test-coverage-gap`
- `2026-08-07-pre-destroy-safe-evidence-capture`
- `2026-08-09-staging-session-task-reconciliation-repair-failures`
- `2026-08-11-clipped-overflow-debt-sweep`
- `2026-08-11-migrate-remaining-source-contract-ui-tests`
- `2026-08-11-project-agent-short-conversation-duplicate-message`
- `2026-08-11-trigger-paused-reason-signal`
- `2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end`
- `2026-08-18-cf-container-single-gate-harness-race`
- `2026-08-18-chat-agent-state-single-do-rpc`
- `2026-08-18-project-data-id-name-identity-source`
- `2026-08-23-get-instructions-missing-observation-ids`
- `2026-08-23-knowledge-injection-followups`
- `2026-08-23-policy-row-retention-bound`
- `2026-09-08-agent-version-metadata-not-published`
- `2026-09-08-ended-chat-requests-deleted-workspace`
- `2026-09-09-chat-requests-reaped-task-404`
- `2026-09-09-docs-site-table-cells-overflow-on-mobile`
- `2026-09-09-node-idle-timeout-project-setting-has-no-consumer`
- `2026-09-09-scheduler-explorer-slot-count-model`
- `2026-09-11-bookmark-anchored-d1-reads`
- `2026-09-12-split-project-data-archive-sharding-module`
- `2026-09-14-www-scrollable-table-wrappers-not-keyboard-focusable`
- `2026-09-23-playwright-audit-shell-mocks-crash`
- `2026-09-23-schedules-panel-hardcoded-poll-interval`
- `2026-09-25-composable-capacity-source-anchor-guard`
- `2026-09-25-reporter-session-switch-unsent-rows`
- `2026-09-25-staging-allocation-plan-no-longer-current`
- `2026-09-25-stopping-sleep-with-failed-projectdata-session`
- `2026-09-25-structured-log-error-text-redaction`
- `2026-09-27-chat-switch-list-first-paint`
- `2026-09-27-workspace-chat-view-transcript-cache`
- `2026-09-28-workspace-page-chat-stop-sends-chat-session-id`
- `2026-09-29-flaky-harness-activity-coalesce-test`

### Kept (could not determine): 4

- `2026-02-23-suppress-background-subagents-in-acp`
- `2026-07-11-codex-staging-oauth-refresh-token-revoked`
- `2026-07-14-stabilize-codex-crash-recovery-reporting-tests`
- `2026-09-08-staging-capacity-query-and-deploy-reset-noise`

## SAM memory (Part 2, done through SAM MCP, not in this diff)

Recorded here so the next weekly run can see what changed.

- **Knowledge updated** because the underlying fact moved this week:
  - Resource telemetry: #2181, #2183 and #2185 closed most gaps. The MCP `get_resource_history`
    tool still caps at 24 chunks with no disclosure.
  - ProjectData storage now measured at 10.30 GB with the breaker open.
  - Prompt-cancel watchdog fixed by #2180.
  - Day-7 conversation failures continue (10 since #2153).
  - Human-input expiry still fails tasks.
  - Task status is still an unreliable "did it ship" signal (#2182, #2136 and #2133 are new cases).
  - Model catalog cron fired 09-28. The catalog-vs-harness gap is repeated and rule 52 does not
    cover it.
  - Instant GitHub token trap fixed by #2174.
  - Unhealthy-node drain shipped in #2147.
  - Admin-operations preference promoted to a policy.
  - Project tracking: `/do` Phase 4 is still skipped.
  - The "no chunks in the UI" preference was applied in #2185.
- **Knowledge added:** Raphaël's repeated frustration with auto-paused triggers (2026-09-22).
- **Knowledge confirmed:** eviction has still never fired in production; the PR Shepherd merges any
  green non-draft PR; the coordinator-killing wake bug is unfixed; the response-style preference.
- **Knowledge retired:** four time-boxed AgentBehavior directives from the 09-07/09-08/09-13
  eventing and hotfix windows.
- **Ideas:**
  - Completed: whole-session resource timeline (`01M3P13H0W6EG1FS47PCG0N2EG`), shipped by #2185.
  - Status notes appended: prompt-cancel watchdog (section B still open), task-status reliability,
    flight-coordinator queue (unowned since its coordinator died), wake bug (still unfixed).
  - Narrowed and retitled: Instant git credentials (`01M25BMJ7FCB3RWQSNE38GAYKX`).
  - Title marker "FULL at 64 KiB": the ACP interactions and ProjectData storage plans, whose
    appends are being dropped.
- **Policies:** one added, `2b97aefc`. Admin operations must be phone-usable buttons in the admin
  UI; Raphaël stated this explicitly on 09-23, but it could not be saved then because the cap was
  full. Nothing else changed, per the brief (policy changes only for explicitly stated
  preferences). Cleanup candidates are listed in the SAM task digest.

## Genuinely open for the week of 2026-10-01 (ranked)

1. **ProjectData root DO over its limit and growing, with the archive breaker open since 09-27.**
   Human-gated: triage the failed and poisoned migrations, then close the breaker in Admin →
   Storage, and decide on the #2161 rollback trigger. Engineering: land Slice C from `7868bc894`.
   (`tasks/active/2026-09-03-projectdata-production-capacity-emergency.md`)
2. **A failed wake attempt permanently fails the conversation**, as with the flight coordinator on
   09-28. Unfixed in `main`. (SAM idea `01M3MFDMZ5AS0BXPHZWS3CRFED`,
   `tasks/backlog/2026-09-25-stopping-sleep-with-failed-projectdata-session.md`)
3. **Check-ins kill agents that are still working** (flight queue item 11). Unowned since the
   coordinator died.
4. **"Expired, not failed."** Day-7 conversation expiry and human-input expiry are recorded as
   failures: about 15 false failures a week, plus failed-but-merged tasks.
   (`tasks/backlog/2026-09-26-trustworthy-task-status.md`, SAM idea `01KZNGJG1DCH8DBC835Y0272P4`)
5. **`update_idea` silently drops appends at 64 KiB.** It is losing updates to the priority-10
   storage plan. (`tasks/backlog/2026-09-30-update-idea-append-silently-truncated-at-cap.md`)
6. **Durable ACP interactions, Slices B–D.** Slice A shipped dormant; activation is authorized.
   (SAM idea `01M3P2E0JJNQRXX020P65ZRKEJ`)
7. **Prompt-cancel section B:** per-session delivery single-flight and one stop per urgent
   delivery. (SAM idea `01M31M9G3T4SEWT9ZW1BM4QKZ3`)
8. **Per-profile agent admin switch (§8)**, confirmed by Raphaël on 09-28 and not started. (SAM
   idea `01M388Y1Q1068DNT69KTBFXSMB`)
9. **Staging contention keeps costing agents time.** `/do`'s check uses a `gh run list` command
   that honors only the last `--status`, so it misses in-progress deploys (SAM idea
   `01M3M0AK930MJXX12TFT9VJ3PH`). Even a correct check cannot see another agent's verification
   window after its deploy finishes; agents overwrote each other's staging twice on 09-29.
10. **The Playwright audit corpus is 99/115 quarantined.** Fix the shell-mock crash first, then the
    umbrella. (`tasks/backlog/2026-09-23-playwright-audit-shell-mocks-crash.md`,
    `tasks/backlog/2026-07-17-stale-playwright-audit-specs.md`)

## Implementation checklist

- [x] Archive the 14 verified-shipped active files with per-item evidence and a provenance footer
- [x] Demote `2026-09-26-trustworthy-task-status` to backlog, narrowed to the unshipped day-7 half
- [x] Append a dated status block to `2026-09-03-projectdata-production-capacity-emergency` and keep it active
- [x] Repair every citation of a moved `tasks/active/…` path across the repo
- [x] Audit all 300 backlog files (10 parallel read-only reviewers, 30 files each), then verify every delete-class verdict
- [x] Delete, consolidate or narrow backlog entries with one-line evidence each; keep anything plausibly open
- [x] Resolve the non-standard `tasks/completed/` directory
- [x] File the `update_idea` silent-truncation bug as a backlog entry
- [x] Post a status nudge or park decision on every open PR older than 7 days (#1788, #1817, #2020, #2062)
- [x] Record the full ledger here and move this file to `tasks/archive/`

## Acceptance criteria

- [x] Every file left in `tasks/active/` has a measurably unmet acceptance criterion and live work:
      only the ProjectData emergency (10.30 GB against a 9 GB target).
- [x] Every archived file has a footer stating how it shipped, and no box is ticked without
      evidence.
- [x] Every backlog deletion or consolidation has a one-line rationale in the PR description and
      in this ledger.
- [x] No citation in the repo points at a task path this PR moved or deleted. Provenance notes
      that name an absorbed file are the only remaining mentions.
- [x] Each open PR older than 7 days has a new 2026-09-30 comment with a concrete status or park
      decision.
- [x] The arithmetic of files before and after closes exactly (see Outcome).
