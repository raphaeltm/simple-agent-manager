# Skip unread GitHub CI project events

## Problem

Reduce Durable Object SQLite writes from GitHub CI admissions without breaking subscribed delivery, replay, deduplication or credential history. SAM task 01M7KYQGMGNWEWMDAAHRDPY8FJ; parent idea 01M7CX61WVX72T7CFQNRTX0DVM. Production investigation is read-only and external reports contain counts only.

## Preflight and research (main a3d3246c0)

Classes: business-logic-change, cross-component-change, public-surface-change, docs-sync-change. Billing unit: DO SQLite rows, including index entries, hidden KV and alarm writes. No new external API integration or infrastructure component.
Data flow: signed POST /api/github/webhook -> synchronous github-project-event-producer -> ProjectData client -> ProjectData.admitProjectEvent -> synchronous transaction -> subscription match -> wake materialization -> durable prompt queue -> runtime steer.
Read parent newest baseline update 01M7KY3Z5FAHAKRWT5FMKBMH55. Cost tool first failed HTTP 401 on placeholder env; managed exec_with_secrets recovered successfully (job sx-41f248d3cd852a28589da9de855b641865704175a8dfaac9bd92c1ed47d6df13). Account 11-16: 2.85M written, 835.4M read; MTD 28.56M written. Two-day projection includes pre-fix regime and is not a causal savings estimate.

## Reader inventory (verified on current main)

| Reader                                                          | Unsubscribed history?                                                                                    | Decision / validation                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| get_event, project-events-pull.ts                               | No: requires visible existing match                                                                      | Existing getter visibility tests + CI route/wake control                                                                                                                                                                                         |
| list_subscription_events, project-events-pull.ts                | No: joins existing matches, cursors seek matches                                                         | Existing pull tests + late subscription control                                                                                                                                                                                                  |
| subscription creation, project-events-subscriptions.ts          | No backfill, cursor or since input                                                                       | Late CI subscription creates no old match; verify schema contract                                                                                                                                                                                |
| channel history/catch-up, project-event-channels-storage.ts     | Yes: reads channel rows by sequence independently of subscriptions                                       | Preserve every channel source; existing channel replay tests                                                                                                                                                                                     |
| wake materializer/storage/targets                               | No: selected matches/batches/subscriptions                                                               | Real CI wake test; unchanged SQL                                                                                                                                                                                                                 |
| GitHub triggers                                                 | Independent GitHub inbox payload, not canonical event history                                            | Verify route composition                                                                                                                                                                                                                         |
| inbox                                                           | Own D1 asks; project events deliver changes through matches                                              | Preserve non-GitHub sources                                                                                                                                                                                                                      |
| Insights/ops                                                    | No: Insights uses activity/receipt facts; canonical event SQL appears only in project-data event modules | Source inventory across packages/apps; ops diagnostics use admin status covered below                                                                                                                                                            |
| admin inspector/status/accounting                               | Yes: recent unmatched CI rows displayed                                                                  | Coordinator accepts changed diagnostic reader in durable message c7ec03d2-fa49-4306-9681-375220c4f9a2: disclose skip mode and recent volatile counts, no per-skip SQL writes. Default ON only with explicit documented inspector behavior change |
| archive/export                                                  | No: ProjectData archive routes chat/session/activity tables, no project_events reader                    | Grep archive contracts and sharding modules: no canonical event table. No event export API exists                                                                                                                                                |
| delivery key duplicate/conflict                                 | Yes for receipts already stored                                                                          | Lookup existing receipt before skip; retain counters/fingerprint conflict semantics; skipped events intentionally have no receipt                                                                                                                |
| findNewerCredentialLimitEvent and provider-limit delivery guard | Yes for credential history                                                                               | Preserve credential and all other non-CI sources                                                                                                                                                                                                 |

## Implementation checklist

- [x] Finish full reader/caller inventory and measure source split read-only or add bounded production counters
- [x] Pin current real-workerd stored admission writes and investigate avoidable indexes/checkpoint writes
- [x] Add typed runtime kill switch and exact GitHub CI scope; preserve existing receipts
- [x] Reuse canonical filter predicates for zero-write skip; distinct outcome with no event
- [x] Add in-memory source/type/outcome counters to existing row_usage window and inspector disclosure
- [x] Real signed webhook -> real DO skip/store/wake tests; prove guard mutation red; alarms unchanged on skip
- [x] Tests for off mode, scope, expired and mismatched subscriptions, existing duplicate/conflict, late subscriptions
- [x] Measure real-workerd before/after skip/store reads and writes, with row meter
- [x] Update public docs and inspector UX; desktop/mobile screenshot audit if UI changes
- [ ] Full lint/typecheck/test/build; local specialist and task-completion reviews
- [ ] Staging lease, real webhook path if possible, subscribed CI runtime wake, cleanup
- [ ] Ready PR, CI and CodeRabbit gate, merge, monitor deploy
- [ ] Four complete production row_usage windows; post counts per covered hour to idea/channel/coordinator

## Acceptance criteria

Zero project_events rows and zero SQLite writes per skipped admission; existing stored receipts still dedup/conflict; valid SHA-specific CI subscriptions store/match/wake; excluded history remains available. Runtime rollback tested. No new unbounded work; state throughput for any new bounds. Honest coverage gaps documented.

## References

Rules 07, 13, 28, 47, 62, 68, 76, 81. Prior cost work: project-event-cost-plans.test.ts, github-project-event-cost-wake.test.ts; migration 077 already removed redundant event indexes. Wake occupancy incident rule 47 requirement 12: do not copy another record's deadline. No migration ships. Proposed082index rebuild was removed before staging: up to an estimated1.7M root rows makes startup JSON index rebuilding too risky. Follow-up: tasks/backlog/2026-11-17-bound-credential-event-index-rebuild.md.

### Additional verified readers and decisions

Standing watches (`project-standing-watches-runner.ts`) select existing `project_event_matches` before `readEventById`, so cannot consume an unmatched event. Provider-limit delivery guard only joins credential rows from an existing wake batch. Agent-message replay reads channel history/delivery keys; all channel sources excluded. Channel subscriptions can catch up before their creation using channel sequence/cursor, but this is never GitHub history. General subscription input accepts no `since` or backfill cursor; pull cursors seek existing matches only.

### Measured implementation evidence

Real workerd, production RowUsage meter: pre-change credential index cold stored admission 9 SQL writes (receipt 5 + first scheduler state 4), steady stored 5; current index steady stored 5 (unchanged); skipped admission 0. Baseline aggregate 7.1 writes/call includes changing mix and alarm work; do not claim fixture writes explain every production call. Final signed-route/rollback/scope/receipt/expiry/overflow suite: 13 passed; five core event suites: 87 passed. Matched admission:26→26 writes. Actual credential lookup query uses the existing index (captured EXPLAIN plan in workerd). Surgical guard deletion: 5 expected failures, 5 controls passed; restore/rebuild completed.
New diagnostic cardinality bound reuses 32-label ceiling. Every admission finishes in the same request; overflow increments a memory counter, never defers work or writes a row. Matcher retains existing 200-active-subscription/100-matches limits and 5 indexed event keys; worst case checks all 200 bounded subscription filters, with no new per-event timer or retry. 2300 admissions/hour is under 1/sec; no backlog is introduced. The 34-type fixture proves all admissions complete while only 32 diagnostic buckets are retained, with two overflow calls disclosed; snapshot cloning is covered.

Coordinator explicitly accepts the inspector as a changed reader (durable message c7ec03d2-fa49-4306-9681-375220c4f9a2): replace skipped CI row visibility with disclosed volatile window counts, default ON, test kill switch. This is an intentional diagnostic contract change, not a claim that the old inspector never read those rows.

### Final scope and rollout plan

The proposed one-write-per-stored-event index cut is deferred: 30-day retention at the recent rate of2300admissions/h implies a conservative1.0–1.7M-row root event table bound, not a measured count. A startup rebuild over that volume risks blocking the root object. No migration remains in this PR; skipped0writes and unchanged stored5writes/matched26writes are the final measurements. The7.1production aggregate is mix-dependent, including index/match/duplicate/scheduling work; no evidence justifies deleting required match or dedup bookkeeping. Skipping unwanted events removes their whole write path, retention deletes and future materialization scans without that startup risk.

Primary staging is allowed by the migration guard (no namespace tags); coordinator confirmed. Reserved primary staging at07:21:42Z, released staging2 reservation. Extend existing bounded signed audit with staging-only check_run/check_suite/workflow_run fixtures;46signing tests pass, production fixture unchanged. Verify three cases live: skip unmatched, full-SHA agent subscription stores and wakes, OFF stores future unmatched; restore settings/clean up. New family fixtures retain the existing maximum2deliveries and2duplicate attempts (≤4signed requests per audit), each network call has a15s budget; no unbounded fanout.

Full local validation before final scope reduction: lint22packages, typecheck36packages, build18tasks, root test39tasks; API16459passed/4skipped, web5368passed, project-data561passed. Final affected regression and signing/security review rerun pending. Screenshot finalboth themes: https://github.com/raphaeltm/simple-agent-manager/pull/2836#issuecomment-6940197711.
