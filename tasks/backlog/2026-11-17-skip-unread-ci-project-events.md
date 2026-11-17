# Skip unread GitHub CI project events

## Problem
Reduce Durable Object SQLite writes from GitHub CI admissions without breaking subscribed delivery, replay, deduplication or credential history. SAM task 01M7KYQGMGNWEWMDAAHRDPY8FJ; parent idea 01M7CX61WVX72T7CFQNRTX0DVM. Production investigation is read-only and external reports contain counts only.

## Preflight and research (main a3d3246c0)
Classes: business-logic-change, cross-component-change, public-surface-change, docs-sync-change. Billing unit: DO SQLite rows, including index entries, hidden KV and alarm writes. No new external API integration or infrastructure component.
Data flow: signed POST /api/github/webhook -> durable GitHub inbox processing -> github-project-event-producer -> ProjectData client -> ProjectData.admitProjectEvent -> synchronous transaction -> subscription match -> wake materialization -> durable prompt queue -> runtime steer.
Read parent newest baseline update 01M7KY3Z5FAHAKRWT5FMKBMH55. Cost tool first failed HTTP 401 on placeholder env; managed exec_with_secrets recovered successfully (job sx-41f248d3cd852a28589da9de855b641865704175a8dfaac9bd92c1ed47d6df13). Account 11-16: 2.85M written, 835.4M read; MTD 28.56M written. Two-day projection includes pre-fix regime and is not a causal savings estimate.

## Reader inventory (verified code; finish call-site audit before implementation)
| Reader | Unsubscribed history? | Decision / validation |
| --- | --- | --- |
| get_event, project-events-pull.ts | No: requires visible existing match | Existing getter visibility tests + CI route/wake control |
| list_subscription_events, project-events-pull.ts | No: joins existing matches, cursors seek matches | Existing pull tests + late subscription control |
| subscription creation, project-events-subscriptions.ts | No backfill, cursor or since input | Late CI subscription creates no old match; verify schema contract |
| channel history/catch-up, project-event-channels-storage.ts | Yes: reads channel rows by sequence independently of subscriptions | Preserve every channel source; existing channel replay tests |
| wake materializer/storage/targets | No: selected matches/batches/subscriptions | Real CI wake test; unchanged SQL |
| GitHub triggers | Independent GitHub inbox payload, not canonical event history | Verify route composition |
| inbox | Own D1 asks; project events deliver changes through matches | Preserve non-GitHub sources |
| Insights/ops | Audit exact call sites | Finish before implementation |
| admin inspector/status/accounting | Yes: recent unmatched CI rows displayed | Coordinator accepts changed diagnostic reader in durable message c7ec03d2-fa49-4306-9681-375220c4f9a2: disclose skip mode and recent volatile counts, no per-skip SQL writes. Default ON only with explicit documented inspector behavior change |
| archive/export | Audit exact allowlists | Finish before implementation |
| delivery key duplicate/conflict | Yes for receipts already stored | Lookup existing receipt before skip; retain counters/fingerprint conflict semantics; skipped events intentionally have no receipt |
| findNewerCredentialLimitEvent and provider-limit delivery guard | Yes for credential history | Preserve credential and all other non-CI sources |

## Implementation checklist
- [ ] Finish full reader/caller inventory and measure source split read-only or add bounded production counters
- [ ] Pin current real-workerd stored admission writes and investigate avoidable indexes/checkpoint writes
- [ ] Add typed runtime kill switch and exact GitHub CI scope; preserve existing receipts
- [ ] Reuse canonical filter predicates for zero-write skip; distinct outcome with no event
- [ ] Add in-memory source/type/outcome counters to existing row_usage window and inspector disclosure
- [ ] Real signed webhook -> real DO skip/store/wake tests; prove guard mutation red; alarms unchanged on skip
- [ ] Tests for off mode, scope, expired and mismatched subscriptions, existing duplicate/conflict, late subscriptions
- [ ] Measure real-workerd before/after skip/store reads and writes, with row meter
- [ ] Update public docs and inspector UX; desktop/mobile screenshot audit if UI changes
- [ ] Full lint/typecheck/test/build; local specialist and task-completion reviews
- [ ] Staging lease, real webhook path if possible, subscribed CI runtime wake, cleanup
- [ ] Ready PR, CI and CodeRabbit gate, merge, monitor deploy
- [ ] Four complete production row_usage windows; post counts per covered hour to idea/channel/coordinator

## Acceptance criteria
Zero project_events rows and zero SQLite writes per skipped admission; existing stored receipts still dedup/conflict; valid SHA-specific CI subscriptions store/match/wake; excluded history remains available. Runtime rollback tested. No new unbounded work; state throughput for any new bounds. Honest coverage gaps documented.

## References
Rules 07, 13, 28, 47, 62, 68, 76, 81. Prior cost work: project-event-cost-plans.test.ts, github-project-event-cost-wake.test.ts; migration 077 already removed redundant event indexes. Wake occupancy incident rule 47 requirement 12: do not copy another record's deadline. No schema/migration change yet planned.
