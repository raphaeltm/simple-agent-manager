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
- [x] Full lint/typecheck/test/build; local specialist and task-completion reviews
- [x] Staging lease, real webhook path if possible, subscribed CI runtime wake, cleanup
- [x] Ready PR, CI and CodeRabbit gate, merge, monitor deploy
- [x] Four complete production row_usage windows; post counts per covered hour to idea/channel/coordinator

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


### Completed release and production observation (2026-11-17)

PR #2836 merged as `8c02e81493af5ba104bcdad89d4ee1519b279553` at 15:55:47 UTC.
Final candidate `5e943cecc` passed CI 44106481715; primary staging deployment
44106479056 passed. Signed audits 44112327721, 44112413348, 44113782089 and
44113797829 proved skip ON, full-SHA subscriber storage/runtime wake, and OFF
storage. Default restored at revision 100; inspector confirmed TRUE. Channel replay
returned the same ID/sequence twice; credential reset persisted. Instant fixture
workspace removed and node absent. The failed preallocation GCP fixture node
`01M7MZRES1XSTZ0F93ERSGFWAW` was never allocated: STS authentication failed before
provider creation, and its provider instance ID remained null. Code corroboration:
`packages/providers/src/gcp.ts:createVMUnclassified` awaits `authHeaders` before
setting `dispatch.sent` and sending the instance POST. Repair task
`01M7NZTWT6AC98R70CGYJJZE0A` independently found zero VMs in the staging Google
project at 00:22 UTC on November 18, then removed the control-plane node record
through the supported owner-attested escape at 00:25 UTC. Follow-up D1 count was
zero, with the named `owner_attested_manual_deletion` audit event. Counts-only job
provenance is on idea `01M7N20Z6P4VWCGG2C6VMZ4QQA`, update
`01M7P0XSWRTGT60TGYNF3D7N49`. Coordinator reviewed these facts and accepted the
never-allocated-node absence evidence (event `1062cbef-cfd6-40cc-a5a9-ed3917eff2b9`).
No provider-termination proof or human waiver is claimed: this case requires
absence evidence because allocation never happened. Cleanup was not duplicated. Lease release 44117420882 succeeded. Mobile/desktop disclosure
screenshots reviewed with no layout issue. Storage/test/UI reviewers PASS or
ADDRESSED; CodeRabbit returned Review skipped, with no findings. PR body retains
full evidence and links.

Production deployment 44174587033 succeeded at 21:28:55 UTC, serving Worker
9432146a at 100%, annotation commit ecb58a6d510219b2429970308a3a2137a4078a9e,
which contains this PR. API health and app returned HTTP 200 (persisted transcript
and PR evidence); deployment success independently reconciled after recovery.
Recovery did not verify an exact filesystem restore or repeat merge/deployment.

Four complete root-project row_usage windows cover 1.00013278 hours:
21:39:49.835–22:24:50.153 and 22:34:04.511–22:49:04.671 UTC. The gap is excluded.
Policy TRUE throughout; admission overflow zero; all windows include admission counters.

| Operation | Calls | Writes | Writes / covered hour | Historical writes / hour |
| --- | ---: | ---: | ---: | ---: |
| admitProjectEvent | 1,583 | 10,686 | 10,684.58 | 16,628.57 |
| alarm:project_event_wake_materialization | 227 | 11,099 | 11,097.53 | 5,142.86 |
| alarm:project_event_retention | Unknown | Unknown | Unknown | 1,942.86 |

Historical baseline: 291,000 admission writes / 40,807 calls over 17.5 hours;
wake 90,000 and retention 34,000 over the same coverage. Admission calls/hour
1,582.79 vs 2,331.83 (-32.12%); writes/hour -35.75%; writes/call 6.7505 vs
7.1311 (-5.34%). Recent comparison 18,434 writes/h gives -42.04%. Wake writes/hour
increased 115.79%, so admission plus wake writes/hour are approximately flat.
This short uncontrolled sample does not establish net event-system or billed savings.
Retention is absent in all four top-32 label sets (27/26/61/37 labels dropped),
which is unknown rather than zero.

| Source/type family | Calls | Created (stored receipts) | Skipped |
| --- | ---: | ---: | ---: |
| github:check_run | 1,047 | 299 | 748 |
| github:check_suite | 129 | 45 | 84 |
| github:workflow_run | 257 | 26 | 231 |
| github:push | 15 | 15 | 0 |
| github:pull_request | 30 | 30 | 0 |
| github:issue_comment | 67 | 67 | 0 |
| github:pull_request_review | 4 | 4 | 0 |
| github:pull_request_review_comment | 4 | 4 | 0 |
| sam | 77 | 73 | 0 |

All GitHub duplicates/conflicts zero; SAM conflicts four. CI total 1,433 calls,
370 created and 1,063 skipped (74.18%). Credential warning one created, zero skipped.
Counters include internal producers, so total 1,630 differs from 1,583 RPC calls.
Detailed CI calls/created/skipped: check_run.created 514/0/514,
check_run.completed 533/299/234; check_suite.completed 115/45/70,
check_suite.requested 14/0/14; workflow_run.completed 82/26/56,
workflow_run.requested 75/0/75, workflow_run.in_progress 100/0/100.

Counts-only evidence posted to idea 01M7CX61WVX72T7CFQNRTX0DVM, update
01M7NVG1ZC9KSAGGPJ5TYG78GJ, channel feature.do-write-cuts and coordinator.
Managed job sx-3e05bdaf552357efb175300b175c41e0a6726e533a18b0f9f3180ed41fe8c390
used only CF_PRODUCTION_DEBUGGING_TOKEN and CF_PRODUCTION_ACCOUNT_ID. No production
settings or fixture mutations. Observability expands dotted type keys into nested
objects; aggregate numeric leaf counters locally. Query upper bound 22:55 exceeded
execution at 22:53:10, but only emitted complete windows through 22:49 counted.

### Final task-completion validation

Compared task research/checklist/criteria with implementation delta
606fefec2..5e943cecc, tests and PR staging/release evidence. No application changes
were reconstructed. Final record-only update checked with git diff --check.

| Check | Verdict | Evidence |
| --- | --- | --- |
| A: Research → checklist | PASS | Reader inventory covered; risky index rebuild explicitly deferred with backlog file. |
| B: Checklist → implementation | PASS | Typed setting, shared matcher, receipt-first skip, counters, inspector, docs and signed fixtures in delta; rollout complete above. |
| C: Criteria → verification | PASS | Real-workerd zero-write/rollback/receipt/expiry/supersession tests plus live signed skip/store/wake audits; production sample and gaps reported. |
| D: UI → backend | PASS | Read-only disclosure consumes inspector admission field; runtime rollback tested through typed settings. No new form input. |
| E: Multiple variants | PASS | Three CI families and non-CI exclusions; SHA, expiry and cancellation controls covered. |
| F: Vertical slice | PASS | Signed webhook through actual DO storage/matching to wake materialization, plus actual staging runtime acknowledgement. |

Remaining limitations: source telemetry is volatile and incomplete across eviction;
retention label unavailable; traffic mix changed; no causal or invoice saving claim.
