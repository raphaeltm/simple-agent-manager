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
- [x] Rebase on main after #2727; push early/often; preserve unrelated .codex/config.toml.
- [x] Lint/typecheck/test/build, migration safety, local specialist reviews and task-completion validator.
- [x] Coordinate staging ownership; deploy and verify real producer/subscription wake on staging.
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

### Final rebased validation and alarm recovery

Rebased onto main after #2727 merged (`a7d05239d`) and rebuilt workspace dependencies so the producer tests include the new system-owner exclusion. Root lint, typecheck, build and full test suite passed (39 test tasks; API 15,166, web 5,228, project-data 528 tests). Subsequent scoped project-data tests (528), API/project-data lint and API typecheck pass after the alarm recovery change. Migration safety passes. The existing unrelated `.codex/config.toml` edit is preserved outside commits.

Admissions also repair missing alarm section memory when an existing due wake becomes enabled after earlier admission. The cold/changed-due/warm controls remain, and a real-runtime recovery test enables wake delivery after a matched event, then admits an unrelated event: exactly one alarm is armed for the existing wake. Removing only the missing-schedule guard makes this test fail; source restored and rebuilt. Four valid runtime mutation proofs now cover checkpoint writes, redundant alarm calls, the identity seek, and missing-schedule repair. Specialist Cloudflare/constitution and test reviews explicitly passed this recovery patch.

Final rebased three-file workerd run passed **19/19** (154s), covering cost plans, real producer CI wakes, alarm recovery and the #2727 system-owner exclusion controls. All four valid mutation red proofs were restored before the run.

Hosted CI [43601939585](https://github.com/raphaeltm/simple-agent-manager/actions/runs/43601939585) passed on exact head `0b6df632c2d8203655a805af0ac596349d77b2f5`, including every Durable Object worker shard, migration safety, full tests, lint, typecheck and build. Staging is coordinated behind the GCP task and then the urgent rollout-gate fix; no owned staging fixtures have been created yet.

### Cost regression post-mortem

What broke: routine project-event admission incurred index, scheduler checkpoint and alarm writes even when no subscriber was due. Retention deletion could read the full match index for every deleted event.

Root cause: the original event schema maintained four secondary indexes that current queries never select; the project-leading match indexes did not support SQLite's event_id-only foreign-key check. Admission refreshed scheduler state and alarm memory without checking whether due times changed. These pre-existing paths are visible in migrations 038/061 and the admission/scheduler wrappers; no claim is made that a recent single commit introduced all three costs.

Why it was missed: semantic unit coverage checked stored records and deliveries without measuring workerd cursor rows or the real multi-ID DELETE plan. Process fix: the new real-runtime test files assert physical counters, actual statement plans, >one-batch throughput and protected-prefix controls, plus producer-to-subscriber delivery. No additional standing instruction files are needed.

Release gates remain pending below; archiving the implementation record after validation does not assert that staging or production deployment has completed.

### Release checkpoint (2026-11-14 15:32Z)

Own staging run [43607699550](https://github.com/raphaeltm/simple-agent-manager/actions/runs/43607699550) is running implementation candidate `ac986afb6f7893501fa0a0953194ab0df968ecc6`; API Worker deployment began 15:29Z after queue/build. Slot ownership was released by the rollout-fix task after its run43605665349 succeeded. No owned staging task/subscription fixtures have been created yet. Branch additionally merged main `3c5921849` (#2732 rollout-gate fix) as `fd9f29607`, preserving identical project-event runtime changes. Production success of that fix remains a merge prerequisite. Signed webhook/wake/browser verification, PR and production release gates are still pending.

Staging fixture ownership checkpoint (15:35Z): marker `github-trigger-audit-d9f62f2c-5439-4f26-97c4-5063d805c9f2`, task `01M7DB4RF839Z6698MH7HP5316`, session `8cb1ad00-835c-459c-b3cf-582564c77683`, project `01KJNR9R3TEN3KX1ETE33852R8`, signed delivery ID `1cfef24c-8fd7-497d-b941-1fe8bb5fc1fa`. One bounded lightweight conversation task, no sizing override. Subscription filter github/issues.opened/issue14112026, expiry45minutes; no GitHub trigger fanout. These are nonsecret ownership IDs for cleanup/recovery, not proof of successful delivery. Worker version `1e99a7af-d010-4b7a-8f8b-1490d471437b` serves candidateac986afb6 at100% (Cloudflare deployment `0287a610-8c46-4558-b7ba-ed80fed94c08`, managed read job `sx-622587f51ebc1b28ae30fbc17dcb0a79928ac36c59e8e448ba18c0b9e50c90dd`). Rollout gate still pending.

### Successful staging wake proof (2026-11-14 16:01Z)

Deploy43607699550 completed SUCCESS, including rollout gate, health and browser smoke. First fixture was interrupted when its shared Hetzner node was deleted by its owner; D1 task_status_events records SYSTEM cancellation at15:38:15.775Z. This was not a container rollout failure. Original fixture fully deleted; unknown caller attribution is tracked separately in idea01M7DC69DF3KX038RC5Y3A99NM, with parent/GCP owner reporting no related deletes.

The single controlled retry used task01M7DC3GNCMCY395T11C1F5ASD, chatc747752d-c2a7-4024-bf57-a4afbd88a23c, workspace01M7DCCARPFH2GAB01GTZXX888, auto-node01M7DC3RSRMMGSYPP6FGNW0FMT, subscriptionce9589a1-1dc2-4c10-9e72-07a6fb913e31. Signed sender [43613111984](https://github.com/raphaeltm/simple-agent-manager/actions/runs/43613111984) passed and posted delivery43a9e80c-5bd4-4209-a725-a21fa14b105a twice (HTTP200 each). Exactly one batch703340a4-7c1f-4aaa-b5b1-d150287b018e was delivered to the real runtime and **acked**, with agent get_event/ack calls and a visible WOKE reply. Ack timestamp1794672012260 (16:00:12.260Z). Browser navigation passed dashboard/project/settings/chat with zero console/page errors; chat screenshot reviewed and shows READY, event notice, tool calls and WOKE. Test resources are being cleaned immediately after the final browser observation; node deletion requires zero remaining workspaces and creation after the owned test task.

Production rollout-fix run43610800149 on main3c5921849 also passed, including Health Check and the successful deployment marker. The coordinator released the external merge hold. ItemC still needs its own PR/final-head CI/CodeRabbit/release gates.

Cleanup confirmed at 16:03Z: cancelled the owned subscription, deleted the retry task and workspace, then deleted its auto-provisioned node only after checking zero remaining workspaces and that the node was created after the test task. Independent GET checks returned 404 for all three resources (managed job `sx-45531e59c07200f8902c6777f986d7b4223a883a43952bb0edf732ebf5e82a94`). Stage slot released to the coordinator. Final browser pass waited for real page content; dashboard, project, settings and chat all returned 200 with zero errors and the chat showed the acknowledged WOKE reply.

After syncing main `567d8c084`, root build passed 18 tasks, targeted real-workerd producer/cost/recovery passed 19/19, and API typecheck passed. The remaining protected-prefix candidate bound is tracked separately in idea `01M7DCY03S5CTP15F71R40VSJV`; the first PR makes no universal O(deletions) claim.


### Late alarm-failure audit (16:28 UTC)

Fault injection exposed a retry gap introduced by skipping unchanged due times: if setAlarm rejects after section memory persists, the next unchanged admission previously did not retry. An in-memory failure flag now retries on the next admission; clearing before each attempt prevents an older success erasing a newer failure. The constructor reads the real stored alarm once under blockConcurrencyWhile and marks missing/later-than-required alarms for repair, covering eviction after failure. Healthy starts perform a read and no alarm write.

Real-workerd same-instance failure test was RED (expected two setAlarm calls, got one) before the correction. Real evictDurableObject tests for missing and late alarms were RED (expected repair call, got zero) before constructor validation. The healthy control initially raced real immediately-due storage maintenance; seeding its legitimate last-measurement timestamp isolates future maintenance. All eight cost-plan tests now pass, including healthy eviction with zero extra alarm writes. Corrected-candidate staging and final review remain pending.

Follow-up cloudflare-specialist PASS and test-engineer ADDRESSED/PASS. Corrected three-file real-workerd suite passed 23/23; project-data lint and API typecheck passed. Corrected staging remains pending.

Integrated main through accounting PR #2729 merge 1c5453f63912837be799cf9a7d2e468bd310bfed. Conflict review passed for constructor metering plus alarm validation, admission transaction metering, and metered alarm retry. Accounting cold fixture now expects 12 (5 event + 4 scheduler + 2 section memory + 1 alarm), down from 16; warm fixture remains 5. Combined four-file real-workerd suite including row accounting passed 32/32; root build 18 tasks, project-data lint and API typecheck passed. Combined-candidate staging is pending.
