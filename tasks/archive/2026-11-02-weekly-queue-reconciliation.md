# Weekly queue reconciliation — 2026-11-02

**SAM task:** `01M6DDGRG41QSJJRQM9A8275PH`
**Branch:** `sam/weekly-queue-memory-reconciliation-8275ph`
**Previous run:** `tasks/archive/2026-10-26-weekly-queue-reconciliation.md` (PR #2444, merge `734896583`).

## Problem

Merged work sits in `tasks/active/`, and `tasks/backlog/` collects entries that shipped, were
superseded, or are duplicates. This run checks both against `main` and production, so the queue
shows only work that is genuinely open. It also posts a status or park decision on every open PR
older than seven days. The SAM memory half (knowledge, ideas, policies) is done through SAM MCP
tools and summarized here, not in the diff.

## Research findings

- The brief estimated about 75 active and 260 backlog files. At `dedb75591` the tree held **4 active
  and 240 backlog** files and 1,319 top-level `tasks/archive/` entries. The brief's numbers are
  stale; SAM knowledge `ProjectTracking` now records the weekly counts.
- Backlog delta since #2444 (`734896583`): 2 files added (`2026-11-01-codex-refresh-ignores-cc-only-pins`,
  `2026-11-02-slept-instant-workspace-deletion-stuck`) and 1 deleted
  (`2026-10-21-docs-expired-chat-spec-drift`). 239 − 1 + 2 = 240.
- 37 first-parent merges landed between `734896583` (2026-10-26 08:03Z) and `dedb75591`
  (2026-11-02 04:05Z). Deploy Production run 41388214850 deployed `dedb75591` successfully, so all 37
  are live.
- 11 PRs are open. 5 were created before 2026-10-26, so they are older than seven days: #1788,
  #2062, #2265, #2308 and #2376. The other 6 are installer drafts #2465 and #2475 and Dependabot
  PRs #2452, #2455, #2456 and #2457, all opened on 10-27 or later.

## Method

1. Built the evidence base in `.tmp/` (not committed): the 37 merges with touched paths and PR
   body excerpts, Deploy Production runs with head SHAs, the backlog delta and the open PRs.
2. Audited the 4 active files directly against each PR's release section and the production
   deploy run. Boxes were ticked only with a cited run, commit or recorded check. Each file got a
   `## Reconciliation 2026-11-02` footer.
3. Delta-audited the backlog with seven parallel read-only reviewers in line-balanced batches.
   Each reviewer checked the complete changed-path list (`git diff --name-only 734896583 dedb75591`,
   1,110 paths) and the code on `main`, not PR titles. The two new files got a full audit. One file
   (`2026-10-21-ai-usage-totals-double-count-sam`) was dropped by the batching filter because its
   name contains "total", and was audited by hand.
4. Removed a backlog file only on a delete-class verdict that I re-checked in code.
5. Read each old open PR's state, recent comments and drift before commenting, and rechecked live
   behaviour where it applied (#2376 redirects, #2265 Sonar configuration).
6. Backlog edits are insert-only dated blocks under the title, above older blocks.

## Outcome

| Directory        | Before |     After |
| ---------------- | -----: | --------: |
| `tasks/active/`  |      4 |     **0** |
| `tasks/backlog/` |    240 |   **237** |
| `tasks/archive/` |  1,319 | **1,327** |

Before: 4 + 240 + 1,319 = 1,563. After: 0 + 237 + 1,327 = 1,564. The archive gained the 4 active
files, the 3 superseded backlog files and this ledger. Nothing was deleted.

## Active: 4 → 0

Every file is merged and live in production. Each got a `## Reconciliation 2026-11-02` footer.

| File                                      | Shipped by        | Production deploy | Boxes left unticked                                                                                                           |
| ----------------------------------------- | ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `2026-10-29-claude-guided-login-repair`   | #2473 `0452e5cef` | 40920874879       | 1: "Draft PR retained unmerged". The hold was lifted when Raphaël confirmed a real-account staging sign-in and asked to ship. |
| `2026-10-30-enable-worker-tracing`        | #2477 `e7e5edef3` | 41088475230       | none                                                                                                                          |
| `2026-10-30-project-guided-account-login` | #2476 `608bdbd1b` | 41056852924       | none (the PR left it "for human closure")                                                                                     |
| `2026-11-01-notification-question-dialog` | #2487 `979acda77` | 41327195249       | none (staging waived by Raphaël)                                                                                              |

Seven stale boxes were ticked, each citing a staging run, production run, trace ID or smoke time
recorded in the PR body or comments.

## Open PRs older than seven days

Each got a dated comment on 2026-11-02 with what changed and the decision that ends the park.
Behind = commits on `main` that are not on the PR branch.

| PR                                    |  Age | Behind | Comment                                                                                           | Recommendation                                                              |
| ------------------------------------- | ---: | -----: | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| #1788 scheduled OSV scan              | 84 d |  1,256 | [6570579363](https://github.com/raphaeltm/simple-agent-manager/pull/1788#issuecomment-6570579363) | Close and keep as an Idea (unchanged since 10-12)                           |
| #2062 sleep-progress moon asset       | 52 d |    740 | [6570578797](https://github.com/raphaeltm/simple-agent-manager/pull/2062#issuecomment-6570578797) | Keep as a draft until Raphaël decides                                       |
| #2265 SonarCloud coverage ingestion   | 25 d |    409 | [6570578147](https://github.com/raphaeltm/simple-agent-manager/pull/2265#issuecomment-6570578147) | Close and keep as an Idea; still no `SONAR_TOKEN`, `SONAR_CI_ENABLED=false` |
| #2308 owner WIP download (draft only) | 22 d |    378 | [6570577349](https://github.com/raphaeltm/simple-agent-manager/pull/2308#issuecomment-6570577349) | Product decision; re-cut or close                                           |
| #2376 apex marketing redirect         | 15 d |    118 | [6570576538](https://github.com/raphaeltm/simple-agent-manager/pull/2376#issuecomment-6570576538) | Close and fix plain HTTP separately; the HTTPS apex already redirects       |

Live check for #2376 (2026-11-02): `https://simple-agent-manager.org/docs/?x=1` → 301 to `www`.
`http://simple-agent-manager.org/` → 522 after 19 s. `http://www.simple-agent-manager.org/docs/` →
301 to `sam-www.pages.dev`. All unchanged since 10-26.

Last week's 9 superseded artifact PRs are gone: #2351, #2352, #2354, #2357, #2361, #2366, #2367
and #1817 were closed on 10-30 after Raphaël changed the PR Shepherd. #1788 is the only one left.

## Backlog: 240 → 237

### Verdict tally (240 files audited)

| Verdict                                 | Files | Action                                              |
| --------------------------------------- | ----: | --------------------------------------------------- |
| UNCHANGED                               |   210 | Kept, no edit                                       |
| UNCHANGED, new file with a lead         |     2 | Kept, dated note                                    |
| PROGRESS                                |    16 | Kept, dated note with what shipped and what is left |
| FIX (pointer moved by a merge)          |     9 | Kept, dated note with the corrected pointer         |
| SUPERSEDED                              |     3 | Archived with a dated note                          |
| SHIPPED / DUPLICATE / OBSOLETE / UNSURE |     0 | —                                                   |

### Archived (3), one line each

- `2026-04-18-agent-key-card-accessibility` (superseded): #2474 (`09b7f3e08`) deleted
  `AgentKeyCard.tsx` (`git grep AgentKeyCard` finds nothing). The replacement `AccountCard.tsx` uses
  `DropdownMenu` labelled "Actions for <account>" (`:253`) and `ConfirmDialog` (`:356`), and
  `AgentConnectForm.tsx:152` is a labelled `radiogroup`.
- `2026-04-18-project-credentials-followups` (superseded): #2474 moved account connection out of
  `ProjectAgentCard.tsx` into the shared `ConnectAccountSheet` → `AgentConnectForm`, which has its own
  OpenCode provider picker, so Finding 1's prop-forwarding has no target. Finding 2 was already done.
- `2026-04-18-project-credentials-playwright-audit` (superseded): its target component's states were
  removed by #2474. The replacement surfaces are audited at 375/1280 px with overflow checks in
  `apps/web/tests/playwright/accounts-settings-audit.spec.ts`.

References between the three archived files were repointed to `tasks/archive/`. No other live file
named them; only older weekly ledgers did.

### Progress since 2026-10-26, note added (16)

- `2026-02-20-acp-session-error-observability`: #2483 adds a redacted, 2 KB-bounded `detail` to unclassified prompt failures; no open item closed.
- `2026-03-13-binary-install-security-hardening`: #2484 installs OpenCode as a pinned, SHA-256-verified release binary; the uv installer is still unpinned.
- `2026-03-28-migrate-file-proxy-token-to-auth-header`: #2477 redacts query strings in Worker logs and traces; `?token=` URLs remain.
- `2026-04-18-credentials-miniflare-integration-tests`: #2490 and #2485 add real-SQLite route tests for resolution and pins; cross-user cases remain.
- `2026-04-18-multi-level-override-framework`: #2490 adds a profile tier for accounts; #2476 adds Constitution Principle XIV.
- `2026-04-18-project-credentials-missing-tests`: HIGH #6 met by #2490's `/agent-key` capability test; LOW #9 and #10 remain.
- `2026-06-04-error-node-cleanup`: #2472 retries deletion of managed deployment nodes in `error`; workspace-role error nodes remain.
- `2026-07-04-fix-flaky-tests-at-root`: three candidates got test-side fixes (#2447, #2480, #2481); the root-cause items remain.
- `2026-07-17-stale-playwright-audit-specs`: #2474 deleted two quarantined specs; 89 of 139 are quarantined.
- `2026-07-23-byo-phase0-review-followups`: #2472 guards deployment teardown on `node_class = 'managed'`, with a real-SQL test.
- `2026-08-07-expand-frontend-query-cache-and-persistence`: #2481 moved ten admin pages and two hooks to TanStack Query.
- `2026-08-18-consolidate-hand-rolled-visibility-polls`: #2481 moved two admin polls to `refetchInterval` that pauses on a hidden tab.
- `2026-09-23-playwright-audit-shell-mocks-crash`: #2481 gave six admin specs their own shell mocks; the central `{}` fallback remains.
- `2026-10-09-cc-attachment-mutations-take-45-seconds`: #2480 batches the reconcile writes; #2489 added another awaiting route; not re-measured.
- `2026-10-22-trigger-field-errors-not-announced`: #2447 wires the new GitHub filter fields; the step-level errors remain unlinked.
- `2026-10-24-regenerate-ideas-feature-screenshot`: #2449 replaced the stale image; whether a Start work shot is still wanted is a decision.

### Pointer corrected, note added (9)

- `2026-03-12-bootstrap-token-dual-auth-dead-code` (#2490 moved `runtime.ts` lines)
- `2026-03-16-notification-ui-accessibility-followups` (#2487 rewrote `NotificationItem`/`NotificationCenter`; the bell panel still has no focus trap)
- `2026-04-09-trigger-api-optimizations` (#2447 moved the query into `trigger-failure-window.ts`)
- `2026-04-20-platform-trial-enabled-env-var` (#2480 split the admin settings registry)
- `2026-05-01-ai-proxy-credential-hardening` (#2490 split agent-key resolution)
- `2026-06-08-same-org-submodule-repo-access` (#2490 moved `runtime.ts` lines)
- `2026-06-15-alternative-inference-providers-backend` (#2474 deleted the old Connect flow; #2490 moved targets)
- `2026-07-23-vultr-onboarding-wizard-parity` (#2474 removed Settings → Cloud Providers)
- `2026-08-11-clipped-overflow-debt-sweep` (#2474 deleted `SettingsCloudProvider.tsx`; four quarantined rows target a removed surface)

### New files, lead added (2)

- `2026-11-01-codex-refresh-ignores-cc-only-pins`: still present; #2490 widened it to profile pins.
- `2026-11-02-slept-instant-workspace-deletion-stuck`: the file's hypothesis looks wrong, since
  `workspace-deletion.ts:614-642` already destroys a sleeping container without waking it. Look at
  `stopNodeResources` and the termination proof instead. #2463, #2472 and #2478 changed this path.

### Unchanged, no edit needed (210)

No merge since 10-26 touched their open scope.

- `2026-02-15-vm-agent-in-place-binary-update`
- `2026-02-16-additional-cloud-providers`
- `2026-02-16-sidebar-redesign-tier2`
- `2026-02-17-persistent-terminal-sessions`
- `2026-02-17-vm-log-browser`
- `2026-02-20-acp-reconnect-replay-integration-test`
- `2026-02-20-agent-session-startup-optimization`
- `2026-02-20-orphaned-session-detection-and-recovery`
- `2026-02-23-suppress-background-subagents-in-acp`
- `2026-02-23-worktree-redesign`
- `2026-02-24-vm-agent-process-lifecycle-and-stability`
- `2026-02-27-tdf-1-task-state-machine`
- `2026-02-28-mobile-nav-dropdown-menus`
- `2026-03-03-improve-test-infrastructure`
- `2026-03-03-simplify-deploy-scripts-and-infra`
- `2026-03-03-simplify-durable-objects-and-schema`
- `2026-03-03-simplify-shared-packages`
- `2026-03-03-simplify-vm-agent-architecture`
- `2026-03-03-simplify-web-app-components`
- `2026-03-03-task-completion-lifecycle`
- `2026-03-04-system-reliability-and-maintainability-hardening`
- `2026-03-07-research-chat-truncation-causes`
- `2026-03-09-fix-task-status-display`
- `2026-03-09-llm-task-prioritization`
- `2026-03-10-log-viewer-test-coverage-gaps`
- `2026-03-13-scaleway-provider-improvements`
- `2026-03-13-wire-provider-env-var-overrides`
- `2026-03-14-fork-dialog-ui-polish`
- `2026-03-14-unified-session-task-workspace-state-machine`
- `2026-03-15-agent-profiles-4-system-prompt-injection`
- `2026-03-16-compute-lifecycle-test-gaps`
- `2026-03-16-mcp-page-size-limits-not-configurable`
- `2026-03-16-notification-phase2-perf-followups`
- `2026-03-16-notification-security-followups`
- `2026-03-16-notification-test-coverage-gaps`
- `2026-03-16-port-exposure-security-hardening`
- `2026-03-17-acp-subagent-idle-detection`
- `2026-03-17-mcp-token-do-storage-security`
- `2026-03-18-code-context-for-task-submission`
- `2026-03-18-fix-git-identity-conversation-mode`
- `2026-03-18-gcp-self-hosting-docs`
- `2026-03-18-workspace-mcp-server-p2`
- `2026-03-19-chat-view-transitions`
- `2026-03-19-graph-execution-model`
- `2026-03-19-mcp-notification-waituntil`
- `2026-03-19-virtual-scrolling-test-coverage-gaps`
- `2026-03-24-deployment-settings-ui-fixes`
- `2026-03-28-file-raw-security-hardening`
- `2026-03-30-account-map-db-indexes`
- `2026-03-30-enforce-per-project-task-execution-timeout`
- `2026-04-01-replace-source-contract-tests`
- `2026-04-03-split-oversized-files`
- `2026-04-08-credential-helper-per-workspace-directory`
- `2026-04-09-document-heartbeat-acp-sweep`
- `2026-04-10-git-show-colon-refspec-injection`
- `2026-04-10-route-level-error-message-leakage`
- `2026-04-10-web-lazy-loading-error-boundaries-a11y`
- `2026-04-12-credential-validity-quota-bypass`
- `2026-04-12-devcontainer-config-secondary-paths`
- `2026-04-13-knowledge-graph-hardening`
- `2026-04-13-knowledge-graph-test-coverage`
- `2026-04-19-trial-late-audit-hardening`
- `2026-04-19-trial-orchestrator-boot-test-coverage-gaps`
- `2026-04-19-trial-orchestrator-step-handler-coverage`
- `2026-04-19-trial-sse-abort-propagation`
- `2026-04-19-trial-sse-cursor-persistence`
- `2026-04-22-infrastructure-nav-and-platform-infra-admin`
- `2026-04-23-deploy-script-security-hardening`
- `2026-04-23-remove-docker-requires-from-vm-agent-systemd`
- `2026-04-24-library-like-escape-clause`
- `2026-04-24-session-header-a11y-token-fixes`
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
- `2026-06-06-library-ui-a11y-preexisting`
- `2026-06-06-projectlibrary-rule18-split`
- `2026-06-07-leak-sweep-test-coverage-gaps`
- `2026-06-07-theme-switcher-playwright-coverage-gaps`
- `2026-06-09-git-credential-loopback-container-binding`
- `2026-06-09-git-credential-node-token-fallback-hardening`
- `2026-06-11-compose-parser-test-coverage`
- `2026-06-12-deployment-provisioning-route-tests`
- `2026-06-12-timeline-drawer-post-merge-fixes`
- `2026-06-17-deploy-engine-security-hardening-followups`
- `2026-06-18-api-composition-root-extraction`
- `2026-06-18-deploy-day2-ops-followups`
- `2026-06-18-vm-agent-bootstrap-pipeline`
- `2026-06-18-vm-agent-lifecycle-idempotent-shutdown`
- `2026-06-20-agent-crash-loop-kitty-keyboard-escape`
- `2026-06-24-compose-publish-x-sam-routes`
- `2026-06-26-admin-user-resource-overview`
- `2026-07-12-cf-container-wake-restore-hardening`
- `2026-07-12-gitlab-token-lock-rate-limit`
- `2026-07-12-multi-installation-cloudflare-namespaces`
- `2026-07-14-stabilize-codex-crash-recovery-reporting-tests`
- `2026-07-16-observability-mcp-outcome-parsing-gap`
- `2026-07-16-project-data-row-fault-isolation-audit`
- `2026-07-19-instant-launch-stuck-queued-on-disconnect`
- `2026-07-19-instant-session-capacity-controls`
- `2026-07-19-repo-history-bloat-cleanup`
- `2026-07-19-split-env-interface`
- `2026-07-20-instant-ping-container-died-midsession`
- `2026-07-21-extend-stale-instant-callback-guard-coverage`
- `2026-07-21-instant-container-request-timeout-cancellation`
- `2026-07-21-project-invite-role-and-link-gaps`
- `2026-07-21-remove-sandbox-env-fallbacks-from-container-runtime`
- `2026-07-23-credential-routes-preexisting-hardening`
- `2026-07-25-admin-ai-proxy-orphaned-default-model`
- `2026-07-25-translate-proxy-sampling-params-4-7-plus`
- `2026-08-03-durable-follow-up-prompt-delivery`
- `2026-08-04-flaky-vultr-ip-poll-error-test`
- `2026-08-04-instant-persistence-step-renders-as-provisioning-vm`
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
- `2026-08-07-fix-stuck-task-sweep-pattern-complexity`
- `2026-08-07-pre-destroy-safe-evidence-capture`
- `2026-08-08-debugging-overhaul-review-followups`
- `2026-08-09-staging-session-task-reconciliation-repair-failures`
- `2026-08-11-migrate-remaining-source-contract-ui-tests`
- `2026-08-11-project-agent-short-conversation-duplicate-message`
- `2026-08-11-trigger-paused-reason-signal`
- `2026-08-11-vm-agent-snapshot-degradation-union-mismatch`
- `2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end`
- `2026-08-18-cf-container-single-gate-harness-race`
- `2026-08-18-chat-agent-state-single-do-rpc`
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
- `2026-09-23-resource-sparkline-gap-marker-has-no-colour`
- `2026-09-25-composable-capacity-source-anchor-guard`
- `2026-09-25-reporter-session-switch-unsent-rows`
- `2026-09-25-split-permanent-session-recovery-refusals`
- `2026-09-25-staging-allocation-plan-no-longer-current`
- `2026-09-25-structured-log-error-text-redaction`
- `2026-09-26-trustworthy-task-status`
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
- `2026-10-12-snapshot-wake-authority-boundary`
- `2026-10-15-recapture-dark-usage-screenshots`
- `2026-10-15-refresh-desktop-hero-capture`
- `2026-10-16-production-do-cost-spike`
- `2026-10-19-gitlab-workspace-token-project-scope`
- `2026-10-19-session-complete-respects-session-writer`
- `2026-10-19-staging-claude-sam-mode-cannot-call-deferred-mcp-tools`
- `2026-10-20-archive-leaves-sleeping-task-sleeping`
- `2026-10-20-automation-page-follow-ups`
- `2026-10-20-comment-idempotency-conflict-returns-500`
- `2026-10-20-file-list-shows-folder-inside-itself`
- `2026-10-20-shared-chat-terminal-and-ports-decision`
- `2026-10-21-agent-profile-blank-agent-type`
- `2026-10-21-ai-usage-totals-double-count-sam`
- `2026-10-21-centralize-agent-and-effort-display-labels`
- `2026-10-21-composer-audit-provisioning-progress-test-fails-on-main`
- `2026-10-21-playwright-audits-failing-or-flaky-on-main`
- `2026-10-21-sam-history-records-primes-json-replies`
- `2026-10-22-github-trigger-late-task-after-exhaustion`
- `2026-10-23-automations-ignore-instant-profile-runtime`
- `2026-10-23-credential-warning-lines-indistinguishable`
- `2026-10-23-ui-compliance-check-never-sees-ui-changes`
- `2026-10-24-cap-linked-chats-per-idea`
- `2026-10-24-capacity-pool-bind-limit-test-timeout`
- `2026-10-24-chat-comment-link-under-failure-banner-on-phones`
- `2026-10-24-chat-drawer-translucency-on-phones`
- `2026-10-24-codspeed-parsecompose-noise-and-stale-baseline`
- `2026-10-24-instant-acceptance-failure-leaves-creating-rows`
- `2026-10-24-typecheck-test-files`

## SAM memory (Part 2, done through SAM MCP, not in this diff)

- **Session review.** About 300 tasks from 10-26 to 11-02 were paged, and 35 of Raphaël's sessions
  were read (user messages only), plus 10 user-role searches. Coverage gap: each search reached only
  4 of 137 archived session owners, so a miss does not prove absence. Agent-written fallback prompts
  appear as `user` messages and were excluded.
  - **Repeated patterns:**
    - Staging waived task by task, about ten times in six days, with two asks for staging.
    - Billed compute left running ("WTF???" 10-30, after deleting 8 stopped VMs by hand).
    - Agents stalling: "Try again" ×4, "Status?", "Carry on".
    - Work left half-shipped: held PRs, and a pushed branch with no PR.
    - The design quality bar: installer "cheap knockoff" / "uncanny valley", video "Fuck I hate it".
    - Plain language, including labelling WIP versus backlog.
    - He names the profile for each role.
    - He expects agents to query production themselves.
    - A UX change he never authorized (load-more conversations).
- **Knowledge: 14 existing observations updated** (each update supersedes the old text, so nothing is lost):
  - Shipped since 10-26: 80% disk gate `45a386e4`, stranded VMs `f4add231`, profile pins
    `cbb4acb0`, consistent layers / Principle XIV `8eae4d01`, notification dialog `6f5f5b8a`,
    Codex refresh gap `148b0e82`.
  - Recurrences added: self-cleanup `4dc9ae4f`, agent nudges `360297e7`, hand-backs and half-shipped
    work `a34693a0`, staging waivers `f8387312`, plain language plus WIP labels `e32b371a`, named
    profiles `5dc8dbcb`.
  - Stale facts corrected: PR Shepherd after the 10-30 change `766c1d8a`, project tracking counts
    `2b20813f`.
  - New-then-corrected: the credential-change observation was first written citing an idea ID
    before that idea existed. It was immediately re-pointed to the real idea (`fb5b66af`).
- **Knowledge: 2 added**: an unauthorized UX tradeoff under performance work (UIUX `133799f4`), and
  resume after an intentional account change (ConfigurationLayers, now `fb5b66af`).
- **Knowledge: 3 retired, 4 confirmed.** Retired: SelfHostingOnboarding `d4111db2` and `ffa6b867`
  (superseded by the 10-28 build authorization) and `b8b208ff` (consumed task-scoped retry
  instruction). Confirmed: `53681c01` (Ideas not GitHub Issues), `7744b849` (production
  smoke only), `c0e60e51` (short plain answers), `8fb7a510` (PR Shepherd approval).
- **Policies: no change.** The 100-policy cap is full. Each explicit candidate is already durable
  elsewhere: consistent override UX is Constitution Principle XIV (#2476), "busy agents never bounce
  email" is in AgentEmail knowledge and idea 01KS4X886T, and the shepherd change is in PRShepherd
  knowledge and trigger 01KPED8FFDM34EZNNFTW672S5E. A standing "UI-only may skip staging" rule
  needs his answer, not an inferred policy.
- **Ideas:**
  - **1 completed** with merged and deployed evidence: 01KYEHTF6B (Claude guided login, #2473).
  - **4 narrowed** (new title plus a note): 01M211FBNN, 01M5Y9YDCH, 01KS4X886T, 01KV05VNSS.
  - **6 notes** on open ideas: 01M5R2BTGX (security, still unfixed), the branch-backed 01M5NG712Y
    (T8 branch, no PR), 01M4QCYXTJ, 01M4QNGECB, 01M643JAEJ, 01M6CQ607M.
  - **4 created** for explicit asks no idea tracked: resume after an account change
    (01M6DFJKADE4D7BJPJQ6BDSK9G), manual delete for an erroring node (01M6DFJTV3VCFEJEBYMK3KYF7A),
    permission prompts despite global bypass (01M6DFJZMK48V95YSVG1HD927K), and the deletion-loop fix
    pushed without a PR (01M6DFK6FWPMPMN0Q8GWQQ57EN).
  - The living queue 01M4DR7MBDD8AAVF1XMC2XYQEX was rewritten as v8.
- **Not reconciled:** about 70 "Recurring platform error" ideas (they need the incident queue) and
  new research or design ideas that no merge touched.

## Genuinely open for the week of 2026-11-02 (ranked)

The same ranking is the living queue, SAM idea `01M4DR7MBDD8AAVF1XMC2XYQEX` (v8).

1. **Public-port GitHub token exposure, still unfixed after 9 days.** Re-dispatch on a Claude
   profile after checking sleeping task 01M5VPHT7NN94K9MBVBGQKR5XM (idea 01M5R2BTGXBWVN8D51CT9GM7HD).
2. **Pinned Codex accounts refresh with, and bill, the default account**, widened by #2490 (idea
   01M6CQ607MR1X3TG98NH3E624B).
3. **Ship the deletion-loop fix pushed without a PR** (branch `sam/use-sam-mcp-tools-v793nz`, idea
   01M6DFK6FWPMPMN0Q8GWQQ57EN). The hung final turn pinning compute is idea 01M5VG7QCDGW77VY1N4QCDJRQK.
4. **Compute never released.** Node 01KXAR1T3XCQKKPBEJEERQ2PSZ is stuck `destroying`, and the retry
   resets its alert clock (ideas 01M66YV81WV900653YTXBQFH6M, 01M211FBNN6J77DMT9KY076VEX). Manual
   delete: idea 01M6DFJTV3VCFEJEBYMK3KYF7A.
5. **Deleting a slept Instant workspace stays `stopping`**
   (`2026-11-02-slept-instant-workspace-deletion-stuck`).
6. **Stale app-route DNS after deployment stop** (idea 01M5T6S34QWSHWAGC4JVM8TJXV).
7. **Finish T8 and the ideas regressions** (ideas 01M5NG712YTCNSBDWWQVR4F0A1, 01M5VG7YRFS34G6W644EQT3CEJ).
8. **Redo the 10-21 "Please fix the filed issues" ask**, cancelled 10-28 with nothing shipped.
9. **Explicit asks with no owner:** permission prompts despite bypass, resume after an account
   change, and the 11-01 security audit's top-3 plan.
10. **One batch of decisions for Raphaël:** the five old PRs above; the installer OAuth client
    (#2465, #2475); the stuck Dependabot owners; a standing staging rule for UI-only fixes; the 09-04
    relief plan; the demo password rotation.

## Implementation checklist

- [x] Audit the 4 active files; archive shipped ones with a provenance footer (4 of 4)
- [x] Tick stale boxes only with cited evidence (7 ticked; 1 left with its reason)
- [x] Repoint every citation of a moved task path (none outside the moved files and old ledgers)
- [x] Delta-audit all 240 backlog files (seven reviewers plus one by hand)
- [x] Remove backlog files only on a verified delete-class verdict (3 archived, each re-checked in code)
- [x] Add a `Reconciliation 2026-11-02` note to every file with progress or a corrected pointer (30 files)
- [x] Post a status nudge or park decision on each open PR older than seven days (5 of 5)
- [x] Record the full ledger here in `tasks/archive/`

## Acceptance criteria

- [x] Every file left in `tasks/active/` is genuinely in progress (none left)
- [x] Every removed backlog file has a one-line rationale with code evidence (3, above and in the PR)
- [x] No reference to a moved task path is left dangling (`git grep` of all 7 old paths)
- [x] Each open PR older than seven days has a dated status/park comment (5 of 5)
- [x] File-count arithmetic reconciles: 1,563 + 1 ledger = 1,564

## References

- `.claude/rules/09-task-tracking.md`, `.claude/rules/38-agent-feedback-and-memory.md`
- `tasks/archive/2026-10-26-weekly-queue-reconciliation.md` (method and conventions)
