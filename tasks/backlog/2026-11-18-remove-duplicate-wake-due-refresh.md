# Remove duplicate project-event wake due refresh

SAM task: 01M7PSJQH5H0S3WBKTP3ZG4NRX. Merge authorized by inbox 01M7PMFRYQ7Q0T86HZ5E6GYZ51.

## Problem and preflight

Business-logic-change: each successful materialization transaction rewrites the subscription due state twice. Billable unit is workerd SQLite rowsWritten including index maintenance. No interface, migration, configuration or observable behavior change intended; task evidence documents the internal optimization.

## Research

Baseline main 0669773a9. Evidence idea 01M7CX61WVX72T7CFQNRTX0DVM notes 01M7PM7Y1K4C62FRDDJTPMRWVH/01M7PM9ZAYEF2AZCT3C5WCEHAQ predicts 69 core writes for one event (63+6N), redundant refresh 8. Verify locally.

materializeCandidate calls claimProjectEventMatchesForBatch, which updates matches then calls refreshWakeDueAtForMatches -> refreshWakeDueAtForSubscription. Immediately after checking claimed count the caller repeats the same refresh with identical project/subscription/now. No intervening SQL, await, trigger or input mutation. Both write MIN(unclaimed matched_at) and identical updated_at. Keep helper ownership so pull and other claim callers retain due updates.

### wake_due_at inventory

Production readers: computeProjectEventMaterializationAlarmTime (due/cooldown MIN); selectWakeCandidates (non-null eligibility/order); terminalizeIneligibleWakeMatchesByPredicate (non-null/order); repairStaleWakeDueAtBackstop (non-null/order). Read-modify-write readers: insertMatchIfAbsent (earliest admitted match); deferWakeTarget (existing earlier due preservation). Migrations 052/057 contain schema probes/backfill/indexes, not runtime scheduling readers. Generic subscription SELECT * passes through mapProjectEventSubscription, which does not expose wake_due_at. Tests directly read for assertions only.

Writers: insertMatchIfAbsent; refreshWakeDueAtForSubscription via claim, terminalization, pull and repair; deferWakeTarget; subscription cancellation/expiry and revoked-source cancellation clear it; historical migrations backfill. These are the same schedule's admission/disposition transitions, not unrelated liveness clocks. Removing caller refresh leaves every reader's final state identical.

Narrow audit: markSchedulerSuccess still writes failure reset/diagnostics; capacity deferral updates target subscriptions and due/cooldown semantics. Neither removed. No batching/retry/ack/authority redesign or SHA coalescing. Rule58 self-consuming wake authority remains unchanged. Related incidents: rule47 target occupancy copying deadline; rule53 schedule-clock ownership; rule58 self-revoking wake re-check.

## Checklist

- [x] Read supplied measurement notes and trace both refreshes and all readers/writers
- [ ] Verify current-main workerd counts, add budget and behavior tests
- [ ] Remove only explicit post-claim refresh
- [ ] Prove cost and scheduler/delivery tests discriminating
- [ ] Run lint/typecheck/tests/build and local specialist reviews
- [ ] Deploy staging and verify Instant subscription -> channel event -> agent wake; clean up/release
- [ ] CI and best-effort CodeRabbit; merge and monitor production deploy
- [ ] Read production row_usage using rpc-split library, compare 48.8/pass and 12.8k/hour; report coordinator

## Acceptance criteria

Real workerd productive core cost falls exactly 8 writes per batch for one/burst events; due state correctly clears or retains remaining matches. Real scheduler/pass loop preserves exact fire times, occupancy, cooldown, retry and delivered events. Staging wake works end to end. All gates pass; production measurement states coverage and uncontrolled-traffic limitation.
