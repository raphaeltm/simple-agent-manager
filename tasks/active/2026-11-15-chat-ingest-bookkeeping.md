# Bound chat ingest bookkeeping writes

Task 01M7GB4125DFTECRYYCAHXAWTS, Part2. Branch sam/chat-ingest-bookkeeping-hxawts, stacked on Part1 (PR2765). No Part2 PR/deploy until Part1 release; rebase only own commits onto main after that release.

## Current implementation

- Additive migration080: durable pending logical count, server ingest/activity/idle clocks, nullable indexed bookkeeping deadline, empty bounded summary-publication queue. No historical index build, destructive migration or per-message index.
- Every accepted batch writes text/idempotency state and durable session receipt synchronously. Steady merged batch2 SQL writes; unmerged4. First dirty receipt also indexes its finite deadline.
- Default interval30 seconds, admin range10–30 seconds, clamped to at most half the idle window. Longer intervals below are measured options only, requiring Raphaël approval.
- Fold canonical count/tag/time in one session UPDATE with derived idle/session/workspace rows and summary enqueue in the same synchronous transaction. No extra session UPDATE to acknowledge D1 publication.
- Direct session/count/activity reads overlay durable pending receipts. D1 summary/list metadata may wait for the fold and publication; exact lifecycle boundaries fold immediately. Browser streaming, message text and retry state remain synchronous.
- End turn, idle, stop, sleep/wake, materialization, archive fence and explicit row seals fold pending state. Idle decisions consult server receipt clocks after restart and external liveness awaits; final D1 commit/local stop share the ingest mutex.
- Summary queue persists claims before D1 await, isolates each queued publication from poisoned peers, fences acknowledgements by version/attempt and retains pending new receipts. Typed retry bounds:5 seconds,12 attempts,15 minute residence; exhausted dirty entries retain state and emit operator errors, never silently renew on ingest.
- Global legacy compatibility seal examines bounded raw rowid pages including closed sessions; durable cursor/ceiling/expiring fence resumes across503/restart. Socket acceptance and fence release share ingest mutex. Typed lease60 seconds and max10k examined sessions; no per-batch extra SQL.
- Serialized alarm scheduling skips unchanged native deadlines when an existing alarm is early enough; persisted section state already avoids unchanged writes.

## Local workerd measurement

Production migrations/indexes,10k historical messages,120 real batches at2 second cadence, due alarms plus end-of-turn flush/publication. Baseline with scheduled idle cleanup: ON11 SQL writes+1 native setAlarm per batch; OFF13+1. Baseline artifact01M7GMAN974JNDZKJM5PQF4770 (/engineering/cost/ingest/ingest-bookkeeping-before.snap) retained unchanged.

| Interval | OFF SQL writes/batch | ON SQL writes/batch | Native writes/batch OFF / ON | Total OFF / ON |
| --- | ---: | ---: | ---: | ---: |
|15s|6.375|4.375|0.250 /0.250|6.625 /4.625|
|30s (approved default)|5.383|3.375|0.150 /0.150|5.533 /3.525|
|60s (measurement only)|4.700|2.708|0.067 /0.067|4.767 /2.775|
|120s (measurement only)|4.533|2.533|0.067 /0.067|4.600 /2.600|

30s reads/batch OFF19.783 /ON25.675. Steady SQL writes OFF4 /ON2 in all intervals. Exact short-window scheduler samples vary with tick boundaries; cost regression tests assert meaningful upper bounds instead of exact timing snapshots. These are local samples, not production forecasts. The1–2 goal is met only for steady batches, NOT amortized; no claim of completed performance target.

30s ON120-batch attribution:120 append writes+128 receipt/index writes;7 alarm folds cost chat28/idle21/state14/workspace7; queue publication45 plus turn enqueue3; scheduler24 SQL+18 native writes. Exact turn end also chat4/idle6/state4/workspace1. Numeric diagnostic evidence /tmp/ingest-bookkeeping-optimized-costs.json; publish durable final artifact after final verification.

## Verification and remaining gates

- [x] Both-mode baseline/per-statement measurement through actual RPCs at10k rows.
- [x] Immediate count/work clocks, older-writer sequence-tag recovery, receipt-after-await idle races for batch/browser, restart-before-old-idle deadline.
- [x] Real alarm summary failure→eviction→retry, pending ingest during publication, poisoned page fairness/terminal bounds.
- [x] Bounded10k all-open and mostly-closed legacy seal, resumed503/eviction fence, targeted seal/materialization.
- [x] Actual sleep→wake→new ingest→eviction→stale alarm in both modes:2passed; no liveness fallback needed, task/workspace preserved.
- [ ] Finish recency/attention regression, run existing merging search/comment-anchor/idempotency regressions on final build.
- [ ] Full quality suite, final specialist/completion/doc review, migration safety (latest4 filesPASS), final before/after artifact and honest amortized target assessment.
- [ ] Part1 release, own rebase/PR, ready CI/CodeRabbit and bounded coordinated staging ON/OFF with strict cleanup; merge and read-only production monitor.

## Constraints

No production provisioning/restarts/test sessions/settings/default changes; no Cloudflare Worker API writes; no VM cadence changes; no archive/storage protection weakening; no new Worker variable. Secrets by name only through exec_with_secrets; no raw logs/content/values in durable artifacts. SAM ideas for follow-ups. Preserve unrelated root .codex/config.toml edit. Part1 takes priority when staging2 L5 holder releases; final diagnostic grant is one Instant/no VM35minutes/USD0.50, then release directly to security2755 task01M7FPX2RR5JSJ1CYG6QPXY9VG.

## Revised performance gate (coordinator00:33UTC)
Verified coordinator event dedad30c removes text-row seal as a required metadata fold trigger: durable text/frontier and effective reads already preserve the needed invariants. Candidate now removes this trigger; endturn/stop/idle/alarm/archive/materialization remain exact. Numbers above describe the prior seal-flush candidate, not the final candidate. New acceptance requires no tested traffic shape increase in either mode, and mixed/thinking-tool profiles to save about20% or stop/report before further polish. Include all SQL/native writes and statement attribution, preserve original matched baselines, use actual Go ExtractMessages→Reporter→HTTP thinking/tool fixture. No Part2 PR before Part1 release.
Whole reporter2100rows/42batches before removing seal flush: OFF6615→6449; ON1596→1727 (8.2% increase). All24 behavior tests passed. Cost snapshot deliberately records this observed limitation; do not misreport it as a saving. New wake-capacity both-mode regression passed after count+pending overlay fix in2d7e12ee3. Broader quality polishing paused at this new performance gate.

## Paused by coordinator (00:53UTC)
Verified event bb957c71-8f74-4fba-84bd-9c523ef32215: checkpoint/push only; no Part2 PR, staging or further implementation. Coordinator will decide shipment/scope using production role/rows-per-batch counters from PR2773. Only live work now is Part1PR2765 diagnostic after L5a then merge/readonlyproductionmonitor if every criterion passes.
Durable numeric before/old/after evidence and fixture proportions are checked into apps/api/tests/workers/fixtures/ingest-bookkeeping-cost/ (READMEtable+threeJSONfiles+itemizedattribution). NewactualGo reporter fixture/provenance test and static no-regression worker guards preserved. Project library artifact01M7GXFTZG4GGWJJ0H8D98759R is an additional copy.
Final no-seal sample total SQL+native OFF/ON: steady634/394 (before1205/965), mixed4row1738/682 (2309/1253), thinking/tool1738/1330 (2309/1901), original2100/50batch6449/1430 (6615/1596). All8 <=before guardsPASS2tests. Mixed4 ON45.6% saving, thinking/toolON30.0%, original50ON10.4%/OFF2.5%; do not generalize to production. OldsealoriginalON+129=84receipt+44queue+1do_meta; earlier+131 has2schedulerwrite difference. Newdefault30s only, no production changes.
Remaining correctness/fullquality and release gates intentionally NOT completed at pause. In particular explicit-seal test expectations still reflect old required flush and must be reconciled if work resumes; AFTERlegacy cost snapshot also predates seal removal. Do not deploy this checkpoint or mark task complete.
