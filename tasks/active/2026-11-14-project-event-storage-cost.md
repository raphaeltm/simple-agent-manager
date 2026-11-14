# Reduce project-event storage writes and retention reads

## Problem and scope

Item C of idea `01M7CX61WVX72T7CFQNRTX0DVM`; SAM task `01M7D1MCRR8APEZ3NG1STREB5P`.
Reduce physical SQLite writes and maintenance reads without changing subscriber or reader behavior.
Do not redo archive/system-project filtering (PR #2727) or RPC accounting (task `01M7CX7ANP9HNSP7PGSBT886WS`).
Use assigned output branch in the primary checkout; rebase after #2727 merges.

## Research — readers before implementation

| Reader                           | Evidence                                                                                                                                                                                                                                                                                                                   | Need unmatched rows?                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Admission matching               | `packages/project-data/src/do/project-events-storage-helpers.ts:95-153` selects active, unexpired indexed subscription candidates then applies filter/visibility/self-origin predicates                                                                                                                                    | Only current matches need events for delivery. Matching happens at admission.                                                            |
| Later ordinary subscription      | `project-events-subscriptions.ts:47-190` creates subscription and match keys, never scans events                                                                                                                                                                                                                           | No historical replay; pin with a before/after subscription test.                                                                         |
| Channels/history/catch-up        | `project-event-channels-storage.ts:191-215` scans channel sequence; `project-event-channels-publish.ts:211-249` assigns channel IDs after admission                                                                                                                                                                        | YES, unmatched channel records remain channel history. Keep full retention semantics. GitHub events are not channel rows.                |
| MCP get/list/pull                | `project-events-pull.ts:77-103,134-177` requires visible existing match; list joins matches to events                                                                                                                                                                                                                      | No unmatched events become readable through these tools. Keep all matched event records.                                                 |
| Standing watches/schedules       | `project-event-schedules-admission.ts`, `project-event-schedules-runner.ts`, `project-event-schedules-delivery.ts` use event admission and canonical subscription delivery                                                                                                                                                 | Preserve all scheduled/lifecycle sources; no generic historical GitHub replay.                                                           |
| Admin recent status              | `project-events-status-retention.ts:59-77`; `project-events-storage-maintenance.ts:54-65,191-201` reads all project events ordered by updated_at, without match filter; `apps/api/src/routes/admin-project-events.ts:247` supplies inspector; `apps/web/src/components/admin/ProjectEventInspector.tsx:659` renders events | YES, full unmatched records are visible to superadmins in Admin project-event inspector. Keep until existing retention permits deletion. |
| Duplicate/conflict admission     | `project-events.ts:124-179`; `project-events-storage-helpers.ts:74-92` reads unique project/source/delivery key, updates counters/state and returns original full event                                                                                                                                                    | YES, for retained delivery keys. Keep existing identity, fingerprints, counters and full result.                                         |
| Credential newer-event check     | `project-events-credential-supersession.ts:26-59` checks stored recorded credential window observations even without matches                                                                                                                                                                                               | YES for credential events; do not change this path or expression-index seek.                                                             |
| Wake materialization             | `project-events-materialization-storage.ts:176-208` reads IDs selected from matches; `project-events-wake-targets.ts:91` joins matches                                                                                                                                                                                     | No unmatched GitHub reader here. Preserve matched wake path.                                                                             |
| Source outbox/lifecycle/producer | `apps/api/src/services/github-project-event-producer.ts:70-100`, lifecycle and source-outbox services consume admission event identity/outcome                                                                                                                                                                             | Keep existing admission contract for every source.                                                                                       |

Decision: retain unmatched rows. Removing them would change the actual admin recent-status view and duplicate/conflict result, contrary to neutral scope. Avoid introducing a separate receipt/history store. Parent coordinator concurred by durable message `3eae514e-9b40-415c-acbc-fb936e38f71b`; this is supporting coordination, not new human authorization.

## Query plans and scan diagnosis

Pre-change real-workerd evidence is recorded below; production implementation and regression coverage are now present.
Indexes: two automatic primary/unique indexes, project_received, source_type, subject, severity, audience, partial channel sequence and partial credential window. Channel sequence costs no insert for ordinary GitHub records. Measure actual rowsWritten rather than index count alone.
Retention alarm `index.ts:3159-3168` passes `refreshAccounting:false`; manual retention defaults to full accounting. Do not attribute manual aggregation to alarm scans.
Potential deletion issue: `project_event_matches.event_id` FK (`migrations.ts:169`) has only project-leading indexes. Inspect DELETE plan for full child-index scans as well as cutoff selection plan.

## Production measurement (rule 76)

Executed `pnpm quality:cloudflare-cost` via exec_with_secrets, job `sx-1386c0acaed3621a9a5971574d7f1251a67d289c5b2fba93c3a65bb6746d5e76`, 2026-11-14 12:56Z.
Usage-derived, not invoice: window November 1–13; 18.41M DO SQL writes and 7.51B reads MTD. Seven-day projection 46.68M writes (50M included), 20.21B reads (25B included). Daily Nov 7–13 writes M: 1.12, 2.10, 1.53, 1.30, 1.35, 1.92, 2.32; reads M: 571.44, 993.67, 702.46, 357.31, 677.14, 1080, 840.93. Full output held by durable job. No savings/invoice claim from local counters.

## Implementation and acceptance checklist

- [x] Capture real workerd EXPLAIN plans and admission counters before implementation; document index decisions and retention scan cause.
- [x] Append-only migration drops only unused indexes; retain every queried/constraint index, add missing retention/FK access if demonstrated.
- [x] No scheduler checkpoint write when retention due time is already established.
- [x] No admission alarm re-arm when neither retention nor wake due time changes; pin cold and changed-due controls.
- [x] Retention uses cutoff seek and indexed delete checks; bounded batch and orphan cursor behavior unchanged.
- [x] Real-runtime counters before/after, including >1 retention batch and large fresh/matched prefixes; state throughput at outer probable limit.
- [x] Preserve unmatched status/idempotency/conflict; preserve matched event delivery via actual webhook producer and real subscription, including check_run/check_suite/workflow_run.
- [x] Pin subscription creation after event as no replay; preserve channel catch-up, credential supersession, schedule/lifecycle tests.
- [x] Delete each new guard, observe intended failing test, restore and record.
- [ ] Rebase on main after #2727; push early/often; preserve unrelated .codex/config.toml.
- [ ] Lint/typecheck/test/build, migration safety, local specialist reviews and task-completion validator.
- [ ] Coordinate staging ownership; deploy and verify real producer/subscription wake on staging.
- [ ] PR, CI, CodeRabbit best-effort wait, authorized merge, production deploy/health smoke.
- [ ] Add idea note with before/after counts and product-reader decision; check item C only after deployment.

### Pre-change workerd results (captured before production edits, 2026-11-14 13:03Z)

`project-event-cost-plans.test.ts` drove real admission/status/retention through a transparent SqlStorage cursor observer. Raw bounded fixture results: `/tmp/event-cost-baseline-large.json` (ephemeral); reproducible assertions will replace scratch reporting.

- First admission SQL: event INSERT **9** + scheduler INSERT **4**; next unmatched event: **9 + 2 = 11**, before outer alarm bookkeeping/setAlarm. Legacy user measurement adds 1 setAlarm = **12** steady-state.
- Delivery lookup: `SEARCH project_events USING INDEX sqlite_autoindex_project_events_2 (project_id=? AND source=? AND delivery_key=?)`.
- ID lookup and materialization ID list: `sqlite_autoindex_project_events_1 (id=?)`.
- Credential newer-window statement: `idx_project_events_credential_window (project_id=? AND source=? AND subject_type=? AND subject_id=? AND <expr>=? AND <expr>>?)`.
- Channel history statement: `idx_project_events_channel_sequence (channel_id=? AND channel_sequence>? AND channel_sequence<?)`.
- Admin status and manual accounting: `idx_project_events_project_received (project_id=?)`; status sorts updated_at separately.
- Retention selection: `idx_project_events_project_received (project_id=? AND received_at<?)`, correlated indexed match lookup, then `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` (index DESC/ASC vs query ASC/ASC).
- Retention DELETE: PK/received lookup plus **`SCAN project_event_matches USING COVERING INDEX idx_project_event_matches_event_retention`**. The foreign-key check binds event_id without project_id, so project-leading match indexes cannot seek. Fixture with **2,000 fresh matched events + 601 expired unmatched events**, deleting 500 in first pass, read **2,020,358** rows with accounting disabled (production alarm mode). This proves the multiplicative scan, rather than guessing from SELECT alone.

Index decision: drop unused source_type, subject, severity and audience indexes. Keep both constraint autoindexes, received index, channel sequence and credential expression indexes. Add match(event_id) for FK delete seeks. Reverse the received index with `ORDER BY received_at ASC,id DESC` to avoid sorting without a one-time rewrite of the populated event index. Equal-timestamp unmatched cleanup order changes, but oldest-first, batch limits and the separate orphan cursor do not. The seek bounds reads by expired candidates; protected old matched records may still need inspection, so no universal O(deletions) claim.

### Throughput and write budget

The existing event-only backlog drains at up to 500 logical events per pass, retrying after the existing 60-second minimum when `hasMore` is true. A 601-event equal-time fixture completes in two passes (one retry interval); a 1M-event event-only backlog needs 2,000 passes, approximately 33h20m. Normal cadence remains 24h. Other retention phases share the physical mutation budget and can reduce event throughput; this change preserves that policy and orphan cursor. New FK index adds one write per stored match, in exchange for removing full child-index scans on each event delete. No index rebuild of existing events is needed.

Steady-state unmatched GitHub admission after the change is **5 SQL writes** (row + primary identity + delivery uniqueness + received-time + credential-window index), **0 scheduler checkpoint writes**, **0 setAlarm calls**. This retains full admin visibility and duplicate/conflict semantics. If a later product decision removes unmatched status visibility, the theoretical no-record path could avoid the event writes, but durable deduplication/fingerprint retention still needs an explicitly designed receipt contract; do not claim zero total writes without that design.

### Review and reproducible measurements

Cloudflare + constitution review PASS on 018650a93. Test review confirms producer/subscriber slice coverage; added direct EXPLAIN assertion on the actual multi-ID production DELETE so losing the PK hint fails independently of a generous read bound. Completion/doc review requested this wording and checklist update and an expired-protected-prefix control.

Current workerd snapshot compares legacy indexes versus the new migration while BOTH sides use optimized selector/deletion code: **2,006,527 → 6,527 reads**, 500 logical deletions, **504 cursor rowsWritten** on both sides. This comparison isolates the FK index; the separate historical 2,020,358-read baseline predates selector reversal and identity hint. Do not confuse the two baselines or infer delete-index billing from admission INSERT counters.

Rule62 runtime red proofs: removing checkpoint WHERE changed steady admission **5 → 7 writes**; removing admission IF made the warm RPC setAlarm assertion fail. Both guards restored; new runtime suites7/7 pass after restoration. The first alarm mutant caused unused-variable compile errors and was discarded as invalid proof; the valid mutant referenced all compared values while forcing the branch.

Expired-protected control now passes: with 2,000 expired protected events ordered before 601 deletable events, first pass deletes 500 with **10,527 reads / 504 writes**, second deletes 101 with **8,533 reads / 104 writes**. All 2,000 protected events and matches survive. Remaining candidate work is linear in the expired protected prefix (plus existing active-match expiry checks), not a table-size-independent universal deletion bound. A follow-up would need bounded candidate windows and a persisted event-retention cursor, fair wrap/recheck semantics, and matching continuation scheduling; it must not weaken live-match protection or cleanup cadence. Under the original permission to split, this PR ships the lower-risk write/FK fixes first; the coordinator confirmed that scope in durable message `1ed24a33-f6cb-40c6-b6d5-aadc75fbdb72`. Record these limits in the PR and the post-deploy idea note.

Identity-hint mutation proof also passed: removing the PK hint makes the actual multi-ID DELETE plan assertion fail, showing `SEARCH project_events ... idx_project_events_project_received (project_id=?)` instead of the required `sqlite_autoindex_project_events_1 (id=?)`. Restored source and rebuilt before rebase/final tests.
