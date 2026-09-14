# Eventing reconciliation and split plan — 2026-09-13

## Scope and ownership

Integration task `01M2CPJWC5TD30E9RCWK6052HX`; parent `01M2CJMWKFGPV064H208AQFXGS`; orchestration idea `01M2CP5QVX8W9YP7WXBNR2XP3B`.

DO NOT MERGE. Phases 1–5 only. No staging deployment, no merge to main, no CodeRabbit request, no modification of PR #2031, no SAM subtasks. Integration branch `sam/eventing-integration` is review/CI material; the parent owns cutting, staging and landing decisions.

## Reconciliation evidence

Draft CI PR: [#2073](https://github.com/raphaeltm/simple-agent-manager/pull/2073). The PR body is the live source for CI results and any subsequent follow-up. This document records the source reconciliation and exact cutting plan; it stays active for the parent’s later stack execution.

- Resumed existing integration at paused `0f150939f`; merged main `afef8d9a6` without rebasing. Pushed merge `0a8d9cecb` preserves both parents.
- Subsequently merged current main `ef3fe1825` (#2069 and #2071) cleanly after CI caught the new main migration collision. Updated validation after that merge is tracked in the PR body.
- Resolved all 21 conflicts. Main resource-plan layering and aggregate capacity admission now survive through reserved submission. Ordinary task allocation permits its normal pending chat linkage; reserved and mismatched identities remain fenced.
- Renumbered pending eventing D1/DO entries while preserving main’s applied prefix. Single wake resolver and checked-in Wrangler default OFF; actual resolver regression proved red before repair.
- Repaired the paused MemoryRouter imports using the installed `react-router` package. Retained the bounded 30-minute Worker CI budget and main’s budget contract test. Exact moved secret-scan candidate bytes match main’s existing reviewed code identifier; only its expiring location digest was added.
- Added a real SQLite→mailbox→adapter→node transport JWT-signing barrier regression: cancellation after preparation prevents physical fetch. Canonical alarm selection now clamps overdue timestamps to now and preserves future/empty results.
- Aligned Worker placement fixtures with main’s observed hardware and effective pool authority; retained physical workspace/first-harness assertions. Extracted recovery context loading to preserve the 800-line file-size gate.
- Independent local Cloudflare/security, Go/test, UI/doc/env/constitution and implementation/split reviews completed. The full inherited feature still requires the parent’s consolidated staging validation before activation.

## Local validation

| Validation                                  | Result                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:fast`                           | PASS: format ratchet, oxlint, 13 lint tasks, zero blocking type-boundary counts                                                          |
| Workspace typecheck / build                 | PASS: 19 / 9 tasks                                                                                                                       |
| API suite                                   | PASS: 729 files, 9,906 tests                                                                                                             |
| Web suite                                   | PASS: 308 files, 3,747 tests                                                                                                             |
| www unit / browser                          | PASS: 49 / 128 tests                                                                                                                     |
| Events browser                              | PASS: 20 mobile/desktop scenarios; additional 320px overflow scenario passed                                                             |
| VM-agent Go / CLI Go                        | PASS: all packages                                                                                                                       |
| ACP race                                    | PASS: 76.7% package coverage; telemetry file 82.2%                                                                                       |
| Quality scripts                             | PASS: 46 files, 612 tests                                                                                                                |
| D1 / DO migration safety                    | PASS; migration compatibility 19 tests, deployment/workflow compatibility 22 tests                                                       |
| Source AST / node-pool boundary / file-size | PASS; AST advisory warnings retained, zero errors                                                                                        |
| Current-tree / PR-range secret scans        | PASS, zero new unreviewed findings                                                                                                       |
| Workers                                     | Full initial diagnostic run plus corrected reserved/credential 54 and cleanup 17 focused cases; frozen-head full result tracked in PR CI |

The initial broad runs found fixture/merge failures; the table records the subsequent successful reruns. An intermediate API run also emitted a Vitest console RPC teardown error; the final 729-file run completed without it. The initial Workers run overlapped a three-second local mutation test and is not represented as final frozen-head proof; remote CI provides that proof. No failed or interrupted run is counted as passing.

[Reviewed screenshot inventory](../evidence/2026-09-13-eventing-integration/README.md): 26 retained captures cover every changed surface on mobile and desktop. All were visually reviewed. Browser APIs were mocked; no staging/production validation is claimed. UI rubric 4/4/4/4/5.

Read-only Sonar verification found that the paused checkpoint `0f150939f` was analyzed after its handoff: quality gate OK, new-code duplication 2.7738621431131287% on 41,855 new lines (analysis 2026-09-07T14:45:35Z). The new draft’s analysis status is tracked separately in the PR; the paused result is not a current-head analysis claim.

Usage checked at 07:06Z: 48% of weekly Codex quota used. Stop near 80%, push and record state if reached. No staging, main merge, PR #2031 mutation, CodeRabbit request, or SAM subtask dispatch occurred.

## Migration mapping

### Migration allocation update after current-main advance

During integration CI, current main advanced to `ef3fe1825` and introduced `0156_archive_sweep_consecutive_budget_stalls.sql` in #2069. The duplicate `0156` ordering check correctly failed. Integration merged that main update and preserved its applied migration allocation. Because eventing migrations remain unapplied, their final D1 allocation is now **0157–0163** (original paused branch **0144–0150**), preserving relative order. The earlier integration allocation0156–0162 is superseded. DO eventing allocations remain **047–056**, after unchanged main045/046. The mapping and split lists above reflect the final allocation.

Neither environment has applied the eventing names; rename only the pending eventing entries. Main D1 through0156 and DO through046 remain unchanged. All migrations belong to split piece1 so subsequent pieces never insert earlier entries into applied order.

| Store | Old pending name                                    | New pending name                                    |
| ----- | --------------------------------------------------- | --------------------------------------------------- |
| D1    | `0144_project_event_source_outbox`                  | `0157_project_event_source_outbox`                  |
| D1    | `0145_credential_limit_windows`                     | `0158_credential_limit_windows`                     |
| D1    | `0146_credential_limit_event_admissions`            | `0159_credential_limit_event_admissions`            |
| D1    | `0147_task_submission_checkpoints`                  | `0160_task_submission_checkpoints`                  |
| D1    | `0148_project_event_source_outbox_durability`       | `0161_project_event_source_outbox_durability`       |
| D1    | `0149_reserved_task_session_revocations`            | `0162_reserved_task_session_revocations`            |
| D1    | `0150_project_event_source_outbox_exhaustion_index` | `0163_project_event_source_outbox_exhaustion_index` |
| DO    | `045-project-event-wake-delivery`                   | `047-project-event-wake-delivery`                   |
| DO    | `046-project-event-wake-retention-indexes`          | `048-project-event-wake-retention-indexes`          |
| DO    | `047-project-event-server-derived-audience`         | `049-project-event-server-derived-audience`         |
| DO    | `048-project-event-channel-member-surfaces`         | `050-project-event-channel-member-surfaces`         |
| DO    | `049-project-schedules-standing-watches`            | `051-project-schedules-standing-watches`            |
| DO    | `050-project-event-wake-due-index`                  | `052-project-event-wake-due-index`                  |
| DO    | `051-project-event-retention-lifecycle-index`       | `053-project-event-retention-lifecycle-index`       |
| DO    | `052-project-event-credential-window-index`         | `054-project-event-credential-window-index`         |
| DO    | `053-mailbox-active-capacity-index`                 | `055-mailbox-active-capacity-index`                 |
| DO    | `054-project-event-orphan-retention-cursor`         | `056-project-event-orphan-retention-cursor`         |

Both `pnpm quality:migration-safety` and `pnpm quality:do-migration-safety` passed; DO migration tests19/19 and deployment compatibility/workflow tests22/22 passed.

## Side branch reconciliation

- `sam/implement-core-event-retention-cjketx`: `c1ff1c719` corresponds to integrated `8d4ebdb50`; 24 file patches byte-identical, remaining code differences only integration context around concurrent env/constants changes. No missing retention/wake implementation found. Its extra `fc72bcfe0` only lowers local reasoning effort xhigh→high and adds workspace trust in `.codex/config.toml`; intentionally excluded from feature integration.
- `sam/fix-event-source-outbox-sp4b5p`: `26772e077` and `3bfb8a15a` correspond to integrated `27834faf2` and `a991a7ccb`. Added implementation lines match; differences are integration context and task checkboxes. `bb343c3d1` final fixes are superseded by later integrated repairs: live final lease fencing (`project-event-source-outbox.ts:286`), indexed exhaustion (`project-event-source-outbox-reconcile-helpers.ts:83`), credential predecessor CAS capture (`project-event-source-outbox.ts:94`), canonical resolver/timeout (`project-event-source-outbox-contract.ts:331`), shared sweep mutation/deadline accounting (`project-event-source-outbox.ts:540`). Workers durability tests retain credential capture and live-final/abandoned lease regressions (`project-event-source-outbox-durability.test.ts:376,502`). No missing runtime fix identified.
- Literal exception: `bb343c3d1` removed the active-attempts index from the existing migration and schema. Integration preserves that index and appends the exhaustion index (now D1 `0163`) instead. Do not blindly cherry-pick the old migration edit. The old extracted `project-event-source-outbox-config.ts` is superseded by the canonical contract module, not missing behavior.

Evidence: `git cherry HEAD <side>` reports 3 outbox and 2 retention non-equivalent commits, so ancestry alone does not prove inclusion. Compared full per-file patches for predecessor pairs, their added lines, and final runtime code/test scenarios. No side branch was modified.

# Eventing integration split map (draft)

Basis: current reconciled working diff against origin/main `ef3fe1825a45abf7728400ba4cdffcec7b749f34`; captured during merge validation. The inventory contains 323 distinct changed files. This is a cutting plan, not proof that seven intermediate builds already passed. Refresh the inventory at the final integration SHA before cutting.

Target: stack onto sam/eventing-feature after updating its base to current main `ef3fe1825` (the feature branch itself was not modified by this task). No deployment or merge authorization is implied. Each slice must independently pass applicable migration safety, typecheck and tests before its successor is cut. Do not cherry-pick the 105-commit history wholesale.

The following primary file lists partition every changed path exactly once. The additional shared-file lists enumerate earlier/later hunk touches; counts include those touches. A primary owner receives the remaining feature-specific hunks, not permission to overwrite earlier pieces. All seven pieces stay under 100 files.

| Piece                                                                      | Primary files | Shared additional touches | Maximum listed footprint |
| -------------------------------------------------------------------------- | ------------: | ------------------------: | -----------------------: |
| 1. Foundation: ordered migrations, contracts, bounded storage              |            54 |                         3 |                       57 |
| 2. Same-chat durable wake and mailbox integration, OFF                     |            33 |                         7 |                       40 |
| 3. Durable source outbox and GitHub/generic producers                      |            24 |                         6 |                       30 |
| 4. Credential-limit telemetry and proxy accounting                         |            45 |                         1 |                       46 |
| 5. Reserved submissions, schedules, watches, live trigger-path integration |            77 |                         6 |                       83 |
| 6. Channels, member subscriptions, API/MCP surfaces                        |            24 |                         6 |                       30 |
| 7. Events UI, remaining docs, and integration evidence                     |            66 |                         0 |                       66 |

## 1. Foundation: ordered migrations, contracts, bounded storage

Dependencies: current main only. Carries **all seven D1 migrations 0157–0163 and all ten DO migrations 047–056**, in numeric order. This deliberately moves schedule/channel/credential schema earlier than the corresponding feature to avoid later appending a lower migration number. `project-event-schedules-schema.ts` must accompany migrations.ts because migration 051 imports it. Shared type/constant barrels also ship together.

Runtime: additive schema, core admission/read/retention/accounting changes; retention may run against existing event data. It is not literally no-op: bounded retention and active-mailbox capacity accounting change storage behavior. No event prompt materialization; resolver and wrangler flag remain false. Risk: medium (SQLite/D1 compatibility and retention correctness).

Hunks: in `project-events.ts`, hold back ONLY exports/imports of materialization and wake-delivery modules until piece 2; core scheduler/retention exports stay here. In ProjectData `index.ts` and `alarm-schedule.ts`, add only retention scheduling/runner hooks and required project-id lookup; leave wake, schedule/watch and channel integrations for their pieces. Whole-file replacement of either entry point is forbidden.

Schema fixture hunk: `tests/unit/routes/mcp.test.ts` must take only the `mockInstructionRows` switch to schema-derived `getTableColumns(schema.tasks)` mapping here. The new `tasks.terminalTransitionId` column shifts main's positional raw rows; postponing this fixture repair until piece 5 breaks existing instruction tests. Keep main's tool-count assertions until the actual tool registrations land. The new alarm-schedule.test.ts belongs wholly to piece 5 because it seeds schedules and asserts deadlines that require the schedule alarm source.

Exact primary file list:

```text
apps/api/.env.example
apps/api/src/db/migrations/0157_project_event_source_outbox.sql
apps/api/src/db/migrations/0158_credential_limit_windows.sql
apps/api/src/db/migrations/0159_credential_limit_event_admissions.sql
apps/api/src/db/migrations/0160_task_submission_checkpoints.sql
apps/api/src/db/migrations/0161_project_event_source_outbox_durability.sql
apps/api/src/db/migrations/0162_reserved_task_session_revocations.sql
apps/api/src/db/migrations/0163_project_event_source_outbox_exhaustion_index.sql
apps/api/src/db/schema.ts
apps/api/src/durable-objects/migrations.ts
apps/api/src/durable-objects/project-data/mailbox-capacity.ts
apps/api/src/durable-objects/project-data/project-event-schedules-schema.ts
apps/api/src/durable-objects/project-data/project-events-credential-supersession.ts
apps/api/src/durable-objects/project-data/project-events-delivery.ts
apps/api/src/durable-objects/project-data/project-events-due-state.ts
apps/api/src/durable-objects/project-data/project-events-limits.ts
apps/api/src/durable-objects/project-data/project-events-mappers.ts
apps/api/src/durable-objects/project-data/project-events-normalization.ts
apps/api/src/durable-objects/project-data/project-events-orphan-retention.ts
apps/api/src/durable-objects/project-data/project-events-pull.ts
apps/api/src/durable-objects/project-data/project-events-scheduler.ts
apps/api/src/durable-objects/project-data/project-events-status-retention.ts
apps/api/src/durable-objects/project-data/project-events-storage-helpers.ts
apps/api/src/durable-objects/project-data/project-events-storage-maintenance.ts
apps/api/src/durable-objects/project-data/project-events-visibility.ts
apps/api/src/durable-objects/project-data/project-events-wake-config.ts
apps/api/src/durable-objects/project-data/project-events.ts
apps/api/src/durable-objects/project-data/row-schemas/project-events.ts
apps/api/src/durable-objects/project-data/types.ts
apps/api/src/env.ts
apps/api/src/lib/bounded-request-body.ts
apps/api/src/lib/runtime-validation.ts
apps/api/tests/unit/durable-objects/migrations.test.ts
apps/api/tests/unit/durable-objects/project-events-pull.test.ts
apps/api/tests/unit/durable-objects/project-events-wake-config.test.ts
apps/api/tests/unit/durable-objects/sql-storage-test-utils.ts
apps/api/tests/unit/runtime-validation.test.ts
apps/api/tests/workers/helpers/project-event-fairness-fixture.ts
apps/api/tests/workers/project-event-orphan-retention.test.ts
apps/api/wrangler.toml
packages/shared/src/agents.ts
packages/shared/src/constants/ai-services.ts
packages/shared/src/constants/credential-limits.ts
packages/shared/src/constants/index.ts
packages/shared/src/constants/project-event-channels.ts
packages/shared/src/constants/project-event-schedules.ts
packages/shared/src/constants/project-events.ts
packages/shared/src/types/index.ts
packages/shared/src/types/mailbox.ts
packages/shared/src/types/project-event-channels.ts
packages/shared/src/types/project-event-schedules.ts
packages/shared/src/types/project-event-subscriptions.ts
packages/shared/src/types/project-events.ts
packages/shared/src/types/task.ts
```

Additional shared-file hunk touches (included in footprint):

```text
apps/api/src/durable-objects/project-data/alarm-schedule.ts
apps/api/src/durable-objects/project-data/index.ts
apps/api/tests/unit/routes/mcp.test.ts
```

## 2. Same-chat durable wake and mailbox integration, OFF

Dependencies: piece 1. Migrations: none (047, 048, 052, 055 already present).

Runtime: mailbox active-capacity enforcement, atomic acceptance/finalization, recovery authority/identity fences and reconciler changes apply to existing deliveries. Event wake engine is installed but dormant with PROJECT_EVENT_WAKE_ENABLED=false. Main's submitting-phase checkpoint and deferred terminal alarm behavior must remain. Risk: high (existing parent wake and session recovery paths).

Hunks: add wake exports withheld from `project-events.ts`; add only event wake alarm hooks/authority RPCs and guarded failSession/linkSession behavior in ProjectData and the project-data service. Add source-task-guard propagation to `task-runner-do.ts` and TaskRunner types, without the `TaskRunnerStartGuard` import, startGuard config or reserved-submission branches. In TaskRunner `index.ts`, carry the switch to `isSessionRecoveryTaskAndEventAuthorized`, event/member config defaults, and `hasRecoveryAuthority` event ProjectData RPC validation now. Keep existing main failure handling; defer startGuard-specific `assertRecoveryAuthority` options/calls and queued-first-start/idempotency changes until piece 5.

The full changed deltas of `node-agent.ts`, its create-workspace-timeout test, `node-lifecycle.ts`, `vm-agent-container.ts`, TaskRunner `helpers.ts` and `node-selection.ts` belong in piece 2. They propagate event batch authority and validate it at VM/container/node-allocation boundaries; waiting until pieces 4/5 would either fail typing on `beforeExternalMutation` or leave authority gaps. Optional requiredProjectMemberId support may travel additively with these guard implementations; scheduled deliveries still are not wired until piece 5. No credential telemetry implementation is present in the vm-agent-container.ts delta. In prompt-delivery-runner.ts defer the import/call of `invalidScheduledDeliveryTarget` and the scheduled_action-specific source guard until piece 5; retain combined parent/event validation and beforeSubmit checkpoint now. If sessions.ts contains reserved-initial-session construction, carry that method with piece 5; identity guard changes stay here. Tests in this piece must use actual default resolver for the dormant case and explicitly activate only positive wake scenarios.

Exact primary file list:

```text
apps/api/src/durable-objects/node-lifecycle.ts
apps/api/src/durable-objects/project-data/attention-expiry.ts
apps/api/src/durable-objects/project-data/durability-foundation.ts
apps/api/src/durable-objects/project-data/mailbox.ts
apps/api/src/durable-objects/project-data/project-events-materialization-storage.ts
apps/api/src/durable-objects/project-data/project-events-materialization.ts
apps/api/src/durable-objects/project-data/project-events-wake-delivery.ts
apps/api/src/durable-objects/project-data/project-events-wake-targets.ts
apps/api/src/durable-objects/project-data/prompt-delivery-runner.ts
apps/api/src/durable-objects/project-data/prompt-delivery.ts
apps/api/src/durable-objects/project-data/reconciliation-candidates.ts
apps/api/src/durable-objects/project-data/reconciliation.ts
apps/api/src/durable-objects/project-data/sessions.ts
apps/api/src/durable-objects/task-runner/helpers.ts
apps/api/src/durable-objects/task-runner/node-selection.ts
apps/api/src/durable-objects/vm-agent-container.ts
apps/api/src/services/node-agent.ts
apps/api/src/services/session-recovery-authority.ts
apps/api/src/services/session-recovery-context.ts
apps/api/src/services/session-recovery.ts
apps/api/src/services/session-snapshot-recovery-lifecycle.ts
apps/api/src/services/vm-prompt-delivery-adapter.ts
apps/api/src/services/vm-prompt-delivery-preparation.ts
apps/api/tests/integration/session-recovery-handoff.test.ts
apps/api/tests/unit/durable-objects/attention-expiry.test.ts
apps/api/tests/unit/durable-objects/durable-prompt-delivery.test.ts
apps/api/tests/unit/durable-objects/reconciliation.test.ts
apps/api/tests/unit/services/node-agent-create-workspace-timeout.test.ts
apps/api/tests/unit/services/session-recovery-event-boundaries.test.ts
apps/api/tests/unit/services/vm-prompt-delivery-adapter.test.ts
apps/api/tests/workers/mailbox-capacity.test.ts
apps/api/tests/workers/project-data-events.test.ts
apps/api/tests/workers/session-recovery-authority.test.ts
```

Additional shared-file hunk touches (included in footprint):

```text
apps/api/src/durable-objects/project-data/alarm-schedule.ts
apps/api/src/durable-objects/project-data/index.ts
apps/api/src/durable-objects/project-data/project-events.ts
apps/api/src/durable-objects/task-runner/index.ts
apps/api/src/durable-objects/task-runner/types.ts
apps/api/src/services/project-data.ts
apps/api/src/services/task-runner-do.ts
```

## 3. Durable source outbox and GitHub/generic producers

Dependencies: pieces 1–2. Migrations: none (0157, 0161, 0163 already present).

Runtime: source intents persist in D1 and retry through outbox; GitHub check_run/check_suite/workflow_run/review and configured generic webhook forwarding begin recording events. App manifest/setup permissions and event read trust fences align with producers. This is live ingress/admission, but does not change normal trigger task submission or enable wake. Risk: medium/high (idempotency, HMAC/auth, private event payloads, exhaustion and retry liveness).

Hunks: `trigger-webhooks.ts` takes only event producer ingress/forwarding changes, preserving main's task-submission route; `scheduled/handler.ts` takes outbox reconcile wiring only. `project-lifecycle-events.ts` takes outbox import and explicit via-outbox helper only, without changing terminal transition callers until piece 5. Self-host page/docs take App event manifest/permission/setup and mobile preview-layout hunks; unrelated docs stay piece 7. Existing project-data admission and event-deliveries read interfaces are already present on main; their imports are not a requirement to pre-land all later changes to those files.

Test/CSS hunk boundaries: the unit source-outbox suite must withhold imports/helpers and admission/revival/supersession cases that call new credential-limit admissions/config/types until piece 4. The Worker source-outbox durability suite may keep SQL-only credential-envelope cases; place its losing-terminal-transition/source-capture race case and transitionTaskToTerminal import with piece 5 to exercise the real new terminal integration, rather than trivially asserting no capture before it is wired. The new self-host-overflow-helpers.ts ships here with its WWW test importers; carry self-host/index.astro mobile preview/layout CSS here so those assertions validate the intended producer/setup slice.

Exact primary file list:

```text
apps/api/src/routes/mcp/project-event-tools.ts
apps/api/src/services/generic-webhook-project-event-producer.ts
apps/api/src/services/github-project-event-producer.ts
apps/api/src/services/project-event-source-outbox-contract.ts
apps/api/src/services/project-event-source-outbox-reconcile-helpers.ts
apps/api/src/services/project-event-source-outbox-storage.ts
apps/api/src/services/project-event-source-outbox.ts
apps/api/src/services/project-lifecycle-event-inputs.ts
apps/api/tests/unit/routes/mcp-project-event-tools.test.ts
apps/api/tests/unit/services/github-project-event-producer.test.ts
apps/api/tests/unit/services/project-event-source-outbox.test.ts
apps/api/tests/workers/generic-webhook-project-events.test.ts
apps/api/tests/workers/github-project-events.test.ts
apps/api/tests/workers/project-event-source-outbox-durability.test.ts
apps/www/public/scripts/self-host-wizard-helpers.js
apps/www/public/scripts/self-host-wizard.js
apps/www/src/components/GitHubAppSetup.astro
apps/www/tests/playwright/github-app-setup-docs.spec.ts
apps/www/tests/playwright/self-host-overflow-helpers.ts
apps/www/tests/playwright/self-host-wizard-generate-link.spec.ts
apps/www/tests/playwright/self-host-wizard-secrets.spec.ts
apps/www/tests/playwright/self-host-wizard-xss.spec.ts
scripts/deploy/utils/github.ts
scripts/quality/github-app-setup-parity.test.ts
```

Additional shared-file hunk touches (included in footprint):

```text
apps/api/src/routes/trigger-webhooks.ts
apps/api/src/scheduled/handler.ts
apps/api/src/services/project-lifecycle-events.ts
apps/www/src/content/docs/docs/guides/self-hosting.mdx
apps/www/src/content/docs/docs/guides/webhook-triggers.md
apps/www/src/pages/self-host/index.astro
```

## 4. Credential-limit telemetry and proxy accounting

Dependencies: pieces 1–3. Migrations: none (0158, 0159, DO 054 already present).

Runtime: VM-agent usage reports, credential reference/generation attribution, observed provider limit windows, threshold events, and proxy accounting become live. Agent runtime credential/proxy handshake and callback schemas ship together. Wake remains OFF. Risk: high (credential privacy/authorization, billing attribution, Go/API compatibility). Run Go race/usage tests plus real-JWT callback and proxy accounting suites. Missing observations must not become fabricated quota authority.

All listed schema/runtime files belong here: splitting ACP report schema or runtime attribution from callback/Go telemetry would create a contract mismatch. Shared contracts and configuration were installed additively in piece 1.

Additional shared-test hunk: complete the credential admissions/config/types imports, helper builders and admission/revival/supersession cases in tests/unit/services/project-event-source-outbox.test.ts withheld in piece 3. The earlier source-only cases remain unchanged.

Exact primary file list:

```text
apps/api/src/routes/ai-proxy-anthropic.ts
apps/api/src/routes/ai-proxy-passthrough-errors.ts
apps/api/src/routes/ai-proxy-passthrough-telemetry.ts
apps/api/src/routes/ai-proxy-passthrough.ts
apps/api/src/routes/ai-proxy-upstream.ts
apps/api/src/routes/ai-proxy.ts
apps/api/src/routes/credentials.ts
apps/api/src/routes/projects/agent-usage-callback.ts
apps/api/src/routes/workspaces/runtime.ts
apps/api/src/schemas/acp-sessions.ts
apps/api/src/schemas/index.ts
apps/api/src/schemas/workspaces.ts
apps/api/src/services/acp-usage-callback-handler.ts
apps/api/src/services/ai-billing.ts
apps/api/src/services/ai-proxy-shared.ts
apps/api/src/services/credential-limit-events.ts
apps/api/src/services/credential-limit-events/admissions.ts
apps/api/src/services/credential-limit-events/config.ts
apps/api/src/services/credential-limit-events/event-builders.ts
apps/api/src/services/credential-limit-events/headers.ts
apps/api/src/services/credential-limit-events/index.ts
apps/api/src/services/credential-limit-events/producer.ts
apps/api/src/services/credential-limit-events/types.ts
apps/api/src/services/credential-limit-events/values.ts
apps/api/src/services/platform-credentials.ts
apps/api/tests/helpers/agent-credential-attribution-fixture.ts
apps/api/tests/unit/acp-usage-callback-auth-real-jwt.test.ts
apps/api/tests/unit/ai-proxy-passthrough.test.ts
apps/api/tests/unit/credential-limit-events.test.ts
apps/api/tests/unit/durable-objects/project-events-credential-visibility.test.ts
apps/api/tests/unit/routes/agent-usage-callback.test.ts
apps/api/tests/unit/routes/ai-proxy-accounting.test.ts
apps/api/tests/unit/routes/opencode-credential-fallback.test.ts
apps/api/tests/unit/runtime-always-proxy.test.ts
apps/api/tests/unit/services/ai-proxy-shared-credential-generation.test.ts
apps/api/tests/workers/composable-credentials-wiring.test.ts
packages/vm-agent/internal/acp/gateway.go
packages/vm-agent/internal/acp/session_host.go
packages/vm-agent/internal/acp/session_host_client.go
packages/vm-agent/internal/acp/session_host_lifecycle.go
packages/vm-agent/internal/acp/session_host_reporting.go
packages/vm-agent/internal/acp/session_host_startup.go
packages/vm-agent/internal/acp/session_host_test.go
packages/vm-agent/internal/acp/session_host_usage.go
packages/vm-agent/internal/acp/session_host_usage_test.go
```

Additional shared-file hunk touches (included in footprint):

```text
apps/api/tests/unit/services/project-event-source-outbox.test.ts
```

## 5. Reserved submissions, schedules, watches, live trigger-path integration

Dependencies: pieces 1–4. Migrations: none (0160, 0162, DO 051 already present).

Runtime: replaces normal trigger submission with durable reserved identities/checkpoints, fences revoked sessions and creator authority, wires one-off schedule/watch alarm runners and exposes schedule APIs/MCP tools. Existing trigger and task lifecycle paths now use the reconciled durable submission flow and source outbox hooks. Schedules/watches can execute after explicit creation; **the event-wake flag does not disable schedules**. Risk: highest (provisioning capacity, session identity, task starts, retry duplication). Keep main's node pools, placement snapshots, wake fixes, and creator/compute gates.

Hunks: finish reserved-submission methods in sessions.ts/ProjectData/service; add scheduled_action guard and invalidScheduledDeliveryTarget to prompt runner now. Finish source recovery/submission integration only after reserved contract and storage are available. `index.ts`/MCP dispatch and tool-definition barrels receive schedule/watch imports, routes and cases only; channel/member cases remain for piece 6. Keep earlier retention/wake/outbox portions of alarm and scheduled handlers. Tests that mock service barrels must preserve real-module exports added earlier. Schedule MCP tools import `channelCallerContext`: introduce only that caller-authentication helper and its existing-main dependencies in `services/project-event-channels.ts` now; leave channel publish/follow/history wrappers and their ProjectData method calls for piece 6. Do not copy the full channel service into piece 5.

Shared fixture hunk: tests/workers/project-schedules.test.ts imports body/fixture from helpers/event-channels.ts. Introduce that helper file's existing-user/project/session setup, MCP tool invoker, actor and body parser here, but omit its publish closure and returned publish property, which reference piece-6 service.publishProjectEventChannel. Add those two channel-only fragments in piece 6. Include the losing-terminal-transition race case from the Worker outbox suite here for meaningful source-capture regression coverage. The entire alarm-schedule.test.ts lands here, when computeScheduleAlarmTime is actually wired.

Exact primary file list:

```text
apps/api/src/durable-objects/project-data/alarm-schedule.ts
apps/api/src/durable-objects/project-data/index.ts
apps/api/src/durable-objects/project-data/message-persistence.ts
apps/api/src/durable-objects/project-data/messages.ts
apps/api/src/durable-objects/project-data/project-event-schedules-authority.ts
apps/api/src/durable-objects/project-data/project-event-schedules-config.ts
apps/api/src/durable-objects/project-data/project-event-schedules-delivery.ts
apps/api/src/durable-objects/project-data/project-event-schedules-recovery.ts
apps/api/src/durable-objects/project-data/project-event-schedules-runner.ts
apps/api/src/durable-objects/project-data/project-event-schedules-storage.ts
apps/api/src/durable-objects/project-data/project-event-schedules-validation.ts
apps/api/src/durable-objects/project-data/project-standing-watches-runner.ts
apps/api/src/durable-objects/project-data/project-standing-watches-storage.ts
apps/api/src/durable-objects/task-runner/index.ts
apps/api/src/durable-objects/task-runner/reserved-project-data-guard.ts
apps/api/src/durable-objects/task-runner/session-linking.ts
apps/api/src/durable-objects/task-runner/state-machine.ts
apps/api/src/durable-objects/task-runner/types.ts
apps/api/src/durable-objects/task-runner/workspace-reserved-allocation.ts
apps/api/src/durable-objects/task-runner/workspace-steps.ts
apps/api/src/index.ts
apps/api/src/routes/mcp/index.ts
apps/api/src/routes/mcp/project-schedule-tools.ts
apps/api/src/routes/mcp/task-tools.ts
apps/api/src/routes/mcp/tool-definitions-project-schedule-tools.ts
apps/api/src/routes/mcp/tool-definitions.ts
apps/api/src/routes/project-schedules.ts
apps/api/src/routes/project-standing-watches.ts
apps/api/src/routes/trigger-webhooks.ts
apps/api/src/scheduled/handler.ts
apps/api/src/scheduled/trigger-execution-cleanup.ts
apps/api/src/services/project-data.ts
apps/api/src/services/project-lifecycle-events.ts
apps/api/src/services/reserved-task-session-revocations.ts
apps/api/src/services/reserved-task-submission-contracts.ts
apps/api/src/services/reserved-task-submission-intent.ts
apps/api/src/services/reserved-task-submission-storage.ts
apps/api/src/services/reserved-task-submission.ts
apps/api/src/services/task-runner-do.ts
apps/api/src/services/task-runner-start-guard.ts
apps/api/src/services/task-terminal-transition-hooks.ts
apps/api/src/services/task-terminal-transition.ts
apps/api/src/services/trigger-submit.ts
apps/api/src/services/workspace-placement.ts
apps/api/tests/integration/node-selection.test.ts
apps/api/tests/integration/webhook-trigger-ingress.test.ts
apps/api/tests/integration/workspace-dispatch-race.test.ts
apps/api/tests/unit/chat-session-management.test.ts
apps/api/tests/unit/durable-objects/alarm-schedule.test.ts
apps/api/tests/unit/durable-objects/project-orchestrator-scheduling.test.ts
apps/api/tests/unit/durable-objects/project-schedule-admission-limits.test.ts
apps/api/tests/unit/durable-objects/project-schedule-recovery.test.ts
apps/api/tests/unit/durable-objects/project-schedules.test.ts
apps/api/tests/unit/durable-objects/task-runner-session-linking.test.ts
apps/api/tests/unit/durable-objects/task-runner-state-machine.test.ts
apps/api/tests/unit/routes/deployment-custom-domains-vertical.test.ts
apps/api/tests/unit/routes/deployment-environment-observability.test.ts
apps/api/tests/unit/routes/deployment-membership-auth.test.ts
apps/api/tests/unit/routes/deployment-release-compose-submission.test.ts
apps/api/tests/unit/routes/mcp.test.ts
apps/api/tests/unit/routes/task-workspace-metering.test.ts
apps/api/tests/unit/services/reserved-task-submission.test.ts
apps/api/tests/unit/services/task-terminal-transition-hooks.test.ts
apps/api/tests/unit/services/task-terminal-transition.test.ts
apps/api/tests/unit/services/trigger-execution-cleanup.test.ts
apps/api/tests/unit/services/trigger-submit-capacity-pools.test.ts
apps/api/tests/unit/services/trigger-submit.test.ts
apps/api/tests/unit/skill-submit-paths.test.ts
apps/api/tests/unit/stuck-task-superseded-termination.test.ts
apps/api/tests/unit/stuck-task-terminal-cleanup.test.ts
apps/api/tests/unit/task-runner-do-service.test.ts
apps/api/tests/workers/project-schedules.test.ts
apps/api/tests/workers/reserved-task-project-data.test.ts
apps/api/tests/workers/reserved-task-submission-task-runner.test.ts
apps/api/tests/workers/task-runner-do-proxy.test.ts
apps/api/tests/workers/trigger-execution-cleanup.test.ts
scripts/quality/node-pool-boundary/inventory-data.ts
```

Additional shared-file hunk touches (included in footprint):

```text
apps/api/src/durable-objects/project-data/prompt-delivery-runner.ts
apps/api/src/durable-objects/project-data/sessions.ts
apps/api/src/services/project-event-channels.ts
apps/api/src/services/session-recovery.ts
apps/api/tests/workers/helpers/event-channels.ts
apps/api/tests/workers/project-event-source-outbox-durability.test.ts
```

## 6. Channels, member subscriptions, API/MCP surfaces

Dependencies: pieces 1–5. Migrations: none (DO 049–050 already present).

Runtime: member subscription/delivery inspection APIs, publish/history/follow/catch-up channels and MCP tools become available. Channel publications can admit events; no automatic event prompt materialization because the flag stays OFF. Risk: high (member/agent audience separation, replay/cursors, capability and untrusted content boundaries).

Hunks: complete channel methods/imports in ProjectData and service proxy; add channel/member route registrations and MCP dispatch/definition entries to the existing shared entry points. Carry only channel/member test cases in the shared MCP suite. Earlier schedule dispatch cases must remain.

Complete the shared tests/workers/helpers/event-channels.ts helper by adding the channel publish closure and returned publish property. All other fixture construction landed with schedule boundary tests in piece 5. No piece-6 primary source/test imports a newly added piece-7 UI module.

Exact primary file list:

```text
apps/api/src/durable-objects/project-data/project-event-channels-authority.ts
apps/api/src/durable-objects/project-data/project-event-channels-config.ts
apps/api/src/durable-objects/project-data/project-event-channels-follow.ts
apps/api/src/durable-objects/project-data/project-event-channels-publish.ts
apps/api/src/durable-objects/project-data/project-event-channels-storage.ts
apps/api/src/durable-objects/project-data/project-event-channels.ts
apps/api/src/routes/mcp/event-subscription-tools.ts
apps/api/src/routes/mcp/project-event-channel-tools.ts
apps/api/src/routes/mcp/tool-definitions-event-subscription-tools.ts
apps/api/src/routes/mcp/tool-definitions-project-event-channel-tools.ts
apps/api/src/routes/mcp/tool-definitions-project-event-tools.ts
apps/api/src/routes/project-event-channels.ts
apps/api/src/routes/project-event-subscriptions.ts
apps/api/src/services/project-event-channels.ts
apps/api/src/services/project-event-deliveries.ts
apps/api/src/services/project-event-subscriptions-access.ts
apps/api/src/services/project-event-subscriptions.ts
apps/api/tests/unit/routes/mcp-event-subscription-tools.test.ts
apps/api/tests/unit/services/project-event-subscriptions.test.ts
apps/api/tests/workers/helpers/event-channel-browser.ts
apps/api/tests/workers/helpers/event-channels.ts
apps/api/tests/workers/project-event-channels.test.ts
apps/api/tests/workers/project-event-delivery-inspection.test.ts
apps/api/tests/workers/project-event-member-subscriptions.test.ts
```

Additional shared-file hunk touches (included in footprint):

```text
apps/api/src/durable-objects/project-data/index.ts
apps/api/src/index.ts
apps/api/src/routes/mcp/index.ts
apps/api/src/routes/mcp/tool-definitions.ts
apps/api/src/services/project-data.ts
apps/api/tests/unit/routes/mcp.test.ts
```

## 7. Events UI, remaining docs, and integration evidence

Dependencies: pieces 1–6. Migrations: none.

Runtime: Events navigation/page with channels, subscriptions, schedules and watches; user-visible setup/docs guidance. Mobile CSS and MemoryRouter test repairs accompany UI; CI budget/duplication/quality evidence updates accompany this final integration slice. Risk: medium (mobile overflow, accessibility, backend/UI contract alignment; misleading activation copy).

**No activation occurs in this piece.** Keep the resolver default and checked-in flag OFF, including docs. A later explicit orchestrator decision may authorize a separate activation-only change after deployment verification. Do not quietly enable the feature because all pieces are present. CLAUDE.md currently has no net diff to main; do not fabricate one. If final validation adds CLAUDE/task-state/split-map files, allocate them here and recount.

Exact primary file list:

```text
.claude/skills/api-reference/SKILL.md
.claude/skills/changelog/SKILL.md
.claude/skills/env-reference/SKILL.md
.github/workflows/ci.yml
apps/web/src/App.tsx
apps/web/src/components/NavSidebar.tsx
apps/web/src/components/project-events/ChannelsPanel.tsx
apps/web/src/components/project-events/EventActionFields.tsx
apps/web/src/components/project-events/EventUi.tsx
apps/web/src/components/project-events/ScheduleExecution.tsx
apps/web/src/components/project-events/SchedulesPanel.tsx
apps/web/src/components/project-events/StandingWatchesPanel.tsx
apps/web/src/components/project-events/SubscriptionDeliveryHistory.tsx
apps/web/src/components/project-events/SubscriptionsPanel.tsx
apps/web/src/components/project-message-view/SessionHeader.tsx
apps/web/src/lib/project-events-api.ts
apps/web/src/pages/ProjectEvents.tsx
apps/web/tests/playwright/project-events-audit.spec.ts
apps/web/tests/unit/components/chat/project-message-view-resume.test.tsx
apps/web/tests/unit/components/project-message-view.test.tsx
apps/www/astro.config.ts
apps/www/src/content/docs/docs/architecture/overview.md
apps/www/src/content/docs/docs/concepts.mdx
apps/www/src/content/docs/docs/guides/scheduled-actions.md
apps/www/src/content/docs/docs/guides/self-hosting.mdx
apps/www/src/content/docs/docs/guides/webhook-triggers.md
apps/www/src/content/docs/docs/reference/api.md
apps/www/src/content/docs/docs/reference/configuration.md
apps/www/src/pages/self-host/index.astro
apps/www/tests/playwright/self-host-wizard-preview-overflow.spec.ts
scripts/quality/gitleaks-reviewed-baseline.json
specs/001-mvp/contracts/api.md
tasks/active/2026-09-06-eventing-delivery-scheduling-channels.md
tasks/active/2026-09-07-credential-event-review-fixes.md
tasks/active/2026-09-07-event-source-review-fixes.md
tasks/active/2026-09-07-event-wake-review-fixes.md
tasks/active/2026-09-07-eventing-recovery-and-channels.md
tasks/active/2026-09-07-reserved-task-submission.md
tasks/active/2026-09-13-eventing-split.md
tasks/evidence/2026-09-13-eventing-integration/README.md
tasks/evidence/2026-09-13-eventing-integration/github-app-setup-docs-long-events-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/github-app-setup-docs-long-events-375x667.png
tasks/evidence/2026-09-13-eventing-integration/github-app-setup-docs-long-preview-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/github-app-setup-docs-long-preview-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-channel-history-long-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-channel-history-long-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-channels-long-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-channels-long-320x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-channels-long-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-schedule-form-conflict-top-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-schedule-form-conflict-top-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-schedules-long-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-schedules-long-320x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-schedules-long-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-subscription-delivery-outcomes-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-subscription-delivery-outcomes-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-subscriptions-long-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-subscriptions-long-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-watch-create-form-top-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-watch-create-form-top-375x667.png
tasks/evidence/2026-09-13-eventing-integration/project-events-watches-long-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/project-events-watches-long-375x667.png
tasks/evidence/2026-09-13-eventing-integration/scheduled-actions-docs-guide-1280x800.png
tasks/evidence/2026-09-13-eventing-integration/scheduled-actions-docs-guide-375x667.png
tasks/evidence/2026-09-13-eventing-integration/self-host-wizard-github-app-desktop-chrome.png
tasks/evidence/2026-09-13-eventing-integration/self-host-wizard-github-app-mobile-chrome.png
```

## Cut verification and coupling checks

- Run migration safety after piece 1 and each successor. DO migration entries 001–046 and main D1 files through 0156 remain byte/order compatible. Do not defer a lower numbered branch migration until a later feature.
- Inspect actual added imports at each cut: project-events.ts exports wake modules (piece 2); migrations.ts imports schedule schema (piece 1); prompt runner imports scheduled validation (piece 5); schedule runner imports submitReservedTask (piece 5); lifecycle helper imports source outbox (piece 3). These are concrete reasons whole-file partitioning alone is insufficient.
- Re-run the focused default resolver scheduler tests after every shared entry-point edit. Default false must be resolved from an empty environment, with explicit true positive control. Main submitting-phase persistence and source authority checks must stay on the real adapter path.
- For each slice, compile and run its affected suites against its actual predecessor; this map has not executed those intermediate builds. Any newly required shared test fixture/import is another counted file, so recount before opening each PR.
- Final union check: git diff --name-only origin/main at the approved integration head must equal the primary inventory plus any explicitly documented later validation/state artifacts. Each shared file final content must match the integration result, preserving main merge fixes.
- Side-branch containment is a separate integration audit owned by the parent; this draft does not assert commit ancestry from file-name similarity.

## Transport/recovery dependency audit follow-up

Piece 2 now owns the node-agent transport callback and its VM/container race regression, NodeLifecycle event/source-member guard SQL, VmAgentContainer full event-authority revalidation, and both TaskRunner source-guard constructors. TaskRunner index is an explicitly counted shared hunk: event-aware authority, event/member config normalization and validation RPC land in piece 2, reserved startGuard semantics in piece 5.

Remaining forward imports from piece-2 sources were checked: attention-expiry uses the existing main transitionTaskToTerminal interface; prompt-delivery/reconciliation use existing main message persistence; recovery uses the piece-2 hunk of task-runner-do; container/recovery authority/adapter use the piece-2 authority RPC and identity-guard hunk of project-data; helper/node-selection types use the piece-2 TaskRunConfig field additions. The sole import of a wholly absent later module, project-event-schedules-delivery, is explicitly withheld from prompt runner until piece 5.

Schedule MCP tools also import channelCallerContext; the piece-5 shared helper hunk is preserved and documented, while channel service wrappers remain piece 6. This avoids creating a backwards schedule-to-channel implementation dependency. No code files were changed by this map audit.

## Feature-branch split execution (2026-09-13)

SAM task `01M2DPWYEJMFZF72F8GC627TMW`, parent `01M2CJMWKFGPV064H208AQFXGS`.
Scope: `/do` phases 1–5 only. No staging deployment, main merge, PR #2031/#2073 modification, or SAM child-task dispatch. The parent retains staging, activation, and merge decisions. The broader eventing task remains active for that handoff.

Source pinned to `f61eb1621473d1948d0edfb0f290c29869ad3cca`. The feature branch was cleanly fast-forwarded from `97a8b2be6` to then-current main `b588f784ce0195d8cf885e10c1dfd7a883c166a5` before cutting. Main had advanced past the request's `0be147ea1` with an unrelated blog commit. The integration merge-base was `ef3fe1825`; the 17 unmapped main-only paths were preserved.

### Ordered commits and verification

Each piece was verified and pushed before assembling its successor. Shared entry points were cut by reviewed diffs, with only the current piece's imports, routes, methods, guards, and fixtures applied. All D1 0157–0163 and DO 047–056 changes landed in piece 1. Checked-in wake configuration remains `false` at every commit; no later piece changes migration files.

| Piece | Commit                                     | Actual changed paths | Local verification                                                                                                                                        |
| ----- | ------------------------------------------ | -------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `ed623812aa7ea96db6c159798bd9d496d95698aa` |                   57 | Workspace typecheck 19 tasks; D1/DO migration safety; DO compatibility 18 tests; API focused 281 + core 134; shared 637; Worker retention 5               |
| 2     | `75d4aa019dba994cbf065cfc445f6147582d5b51` |                   39 | API typecheck/lint; focused unit 205; Worker wake/mailbox/recovery 55; migration safety                                                                   |
| 3     | `05a1e92a6d1ad431629f8ad39f910bcbb97c59aa` |                   33 | API/www typecheck; API unit 114; Worker 23; www unit 49; GitHub setup parity 2; affected browser 118; migration safety and lint                           |
| 4     | `f78831c43db51e27e7a563eb131d77595087e932` |                   47 | API typecheck/lint; API unit 127; Worker credentials 23; full VM-agent Go suite; ACP race with 76.6% package coverage                                     |
| 5     | `95114842ee17a7f2bac6236a175cb53006116df8` |                   80 | API typecheck; unit/integration 676; Worker 84; workspace lint 13 tasks; D1/DO safety and node-pool boundary                                              |
| 6     | `c8018543327c44e9bf7349a6f48273b51508cc2f` |                   30 | API typecheck/lint; full API 731 files / 9,925 tests; channel/member/delivery Worker 25; D1/DO safety                                                     |
| 7     | This commit (`eventing piece 7/7`)         |                   65 | Workspace typecheck/lint/build/test tasks; web 3,747 tests; Events browser 20 + narrow 2; WWW browser 16; docs/structural checks; final specialist review |

### Necessary boundary corrections and resolved failures

The 323-file inventory was retained, with the following necessary departures from the map’s piece assignments. Inspection and executable checks exposed hunk-placement errors; changes were restricted to dependencies required by the current piece:

- Piece 2's reconciliation fixture delta expected the terminal-transition SQL contract that arrives in piece 5. Its five failing tests were repaired by retaining the predecessor fixture in piece 2 and applying the exact source fixture in piece 5. An accidentally included unused reserved-start parameter/import was removed before committing piece 2.
- Piece 3's actual outbox reconciliation call is in `scheduled/trigger-execution-cleanup.ts`; `scheduled/handler.ts` only forwards its statistics. The outbox-only runtime hook and matching cleanup fixture landed in piece 3, leaving credential cleanup for piece 5. The webhook ingress fixture delta is entirely source-producer schema/stub behavior and also belongs in piece 3. This resolved four webhook and two cleanup fixture failures. Credential-dependent outbox tests stayed in piece 4; the losing terminal-transition Worker race stayed in piece 5.
- The scheduled-actions documentation navigation case in `github-app-setup-docs.spec.ts` requires the guide/sidebar from piece 7. That single case was held from piece 3 and restored in piece 7.
- The usage callback import and route registration in `src/index.ts` are required to expose piece 4 telemetry. Only that hunk moved to piece 4; schedule/watch registrations remained in piece 5 and channel/member registrations in piece 6.
- Source-only fixture/import lint failures were corrected before their commits. Piece 5's partial channel-authentication helper had an extra trailing blank line; the whitespace check caught and removed it before commit.
- Local browser prerequisites initially lacked Chromium and system libraries; both were installed and the affected piece 3 browser suite passed. Piece 7's first WWW browser startup collided with the workspace test task's own Astro build; a serialized rerun passed. The temporary 320px audit config initially could not resolve Playwright outside the package; its local import path was corrected. These setup attempts are not counted as passing tests.
- An initial piece 1 baseline typecheck overlapped extraction and was discarded. The actual assembled piece 1 then passed its own complete workspace typecheck.

### Final validation and review

All required local checks passed:

- `pnpm typecheck`: 19/19 tasks; `pnpm lint`: 13/13; `pnpm build`: 9/9. Existing lint, Astro baseline, bundler and Turbo output warnings remain unchanged.
- `pnpm --filter @simple-agent-manager/api test`: 731 files / 9,925 tests. `pnpm exec turbo run test --filter='!@simple-agent-manager/api'`: 19/19 test/build tasks, including web 308 files / 3,747 tests and www 49 tests. Together these cover the workspace test task surface without repeating the unchanged API suite after piece 7's UI/docs-only extraction.
- Events Playwright audit: 20/20 mobile/desktop cases. Additional 320px run: 2/2 cases (project and existing admin stress scenarios). Affected WWW guide/preview browser suite: 16/16; documentation links: zero broken links across 29 pages.
- Agent-context budget measurement, skill-reference resolution, migration ordering, node-pool boundary, type boundaries, source-contract tests and Wrangler binding checks passed. Context measurements changed no startup guidance or configuration.
- Fresh screenshot review passed. Twenty-four mapped images were refreshed; the two original wizard images retain integration provenance. See the screenshot evidence README.

All 323 mapped files exist, and exactly those 323 paths differ from the fast-forward baseline: no unmapped main content was reverted. Before execution/evidence annotations, 322 matched integration byte-for-byte. The only source difference is the preserved newer-main resource-sizing paragraph in `apps/www/src/content/docs/docs/guides/self-hosting.mdx` (legacy labels map to workload slices and do not rewrite native provider payloads). All eventing hunks in that file match integration.

Local specialist reviewer `split_review` passed pieces 1–6 (Cloudflare, security, environment, constitution, Go, reserved submission, and channel/member boundaries as applicable). Final UI/test/task-completion checks A–F passed. UI rubric: hierarchy 4, interaction 4, mobile 4, accessibility 4, consistency 5. Documentation review passed the changed public contracts with the inherited reference-wording warning recorded below. No reviewer was dispatched as a SAM task.

Inherited nonblocking findings were recorded without changing the source extraction: the credential observation callback schema has a fixed 16-observation cap despite a configurable producer maximum (idea `01M2DRFXAHEBSQ1HQJDEKEEAGB`); the API-reference skill has stale delivery/UI wording (idea `01M2DS0GD1N13QASEWX1PNBWCM`). Public wake configuration documentation correctly remains OFF.

The optional repository-wide `quality:browser-evidence` command expects a complete unrelated Storybook screenshot matrix and failed its missing local Storybook-index prerequisite. It is not claimed as an eventing verification result; this task uses the real-router Events and affected WWW browser audits. No changed shared UI primitives require that matrix.

Weekly usage telemetry was 72% at final validation, below the requested near-80% stop threshold. The seven commit SHAs and final pushed head are also reported through the SAM task status/completion record.
