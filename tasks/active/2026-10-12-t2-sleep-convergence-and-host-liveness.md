# T2: sleep convergence and host liveness

Task 01M4QPDF9YRSHRQK2G7KYEXX0K; reliability-wave-1012.

## Problem / evidence
Lost completion callbacks plus already-stopped runtime leave snapshot stopping, chat sleeping, task active, workspace running. Node heartbeat fanout refreshes ACP despite stopped host. Long LIKE pattern breaks D1 dedupe.

## Research
- scheduled/session-sleep-candidates.ts excludes stopping past immutable in-flight window.
- scheduled/session-sleep-lifecycle-repair.ts requires workspace sleeping; running stale rows have no convergence owner.
- services/session-sleep-teardown.ts requests chat sleeping before stop; exact 409 stopped is currently thrown.
- ACP fanout trusts node presence. Existing listAgentSessionsOnNode supplies hostStatus; inspect only suspect-task/idle-cleanup adapters, zero additional heartbeat I/O; no VM rollout required.
- scheduled/stuck-task-live-runtime.ts serialized preservationKey LIKE exceeds D1 50-byte limit; use literal instr with bound JSON key.
- rules 53, 62, 74 govern liveness and real producer regression evidence.

## Checklist / acceptance
- [x] Idempotent stop handles exact already-stopped response, other errors remain failures.
- [x] Stale stopping running rows converge through existing teardown with verified recovery point; unconfirmable rows visibly blocked within existing window/budget.
- [x] Node heartbeat remains a proxy; bounded suspect-task host inspection prevents stopped/released hosts looking alive; genuine running control.
- [x] Dedupe uses real D1 test, handles literal key boundaries.
- [x] Real sweep/routes regressions: 409 stopped, lost completion, in-flight control, warm retention, no recovery blocked, wakeability.
- [x] Revert changes once, record discriminating red tests.
- [ ] Sequential lint/typecheck/tests/build; completion/cloudflare/constitution/test specialist review.
- [ ] Coordinated staging claim, one VM sleep/wake closest failure path, clean up (<60m <=2 VMs no pool edits).
- [ ] PR/CI/CodeRabbit; MERGE_READY then MERGE_GRANT; prod deploy + read-only stopping check; DONE before complete_task.

## Constraints
Only assigned branch writer, no production manual lifecycle changes. API only preferred. Shared edits session-sleep-teardown.ts and session-sleep-lifecycle-repair.ts announced before writing (#2305); avoid T1 eviction/finalizer linking code. No new vars, auth bypass, credentials/security changes or purchases.

## Implementation and verification state
- Shared preservation predicates unchanged. New scoped converger claims before stuck-task terminal verdict using the same sleep CAS, existing 5 s background stop timeout, at most five attempts per tick (bounded further by existing candidate limit). Overflow hands off to sleep sweep.
- Original episode clock/counter bounds ambiguous stop; exact-record DO blocked RPC, task EXISTS fence, durable retry deadline prevent late/new-episode mutation and lost finalization. Block retains nonterminal task awaiting_followup with actionable error; no destructive task-failure cleanup of uncertain runtime.
- Thin additive confirmed-sleep DO RPC retires only matching obsolete idle cleanup and idle_cleanup_failed markers. New helper modules keep shared files small. #2305 overlaps: session-sleep-teardown.ts and session-sleep-lifecycle-repair.ts.
- Liveness probes existing host endpoint only after candidate timeout; caps 100 stuck candidates / 5 idle-cleanup candidates, timeout 5 s, unknown inconclusive. Exact ready/starting/prompting host keeps genuinely running agents live; stopped/error/idle/omitted host is stopped. No VM changes.
- Literal parameterized instr fixes D1 long-key dedupe, special characters and key suffix controls.
- 59 integration tests passed including real stale stuck-before-sleep sweep (25 h runtime), actual ensureSessionRecovery to TaskRunner boundary + restore route, missing /complete route, cap five, cross-sweep single action, missing/expired recovery blocked, warm retention and original budget controls.
- Remaining unchecked workflow gates are pending execution, not deferred: final real Workers rerun, full root tests/build, archive/completion/doc-sync review, staging claim/repro/cleanup, PR gates/coordinator grant and production read-only verification. Do not archive or merge yet.

## Revert proof (2026-10-12)
Tracked API source reverted to branch HEAD while retaining new tests, then restored byte-for-byte from /tmp backup. Core probe: 5/5 red (stale stop D1 running/stopped reaching wake, cross-sweep single teardown, convergence cap, original-budget unconfirmed stop blocked). Real Workers probe: 9/10 red; stopped/null/omitted hosts stayed falsely live, unknown probes falsely live, and long-key D1 dedupe produced duplicate records. Running-host / in-flight assertions also red where they require the new host condition/probe; released sleeping control stayed green. No tests or source left reverted. 59 integration tests passed after restoration; final broad/Workers gates pending.

## Final review corrections
- A chat may have multiple active historical ACP rows. The single bounded VM listing evaluates every task/workspace candidate, unless an explicit expected ACP ID narrows it. Any running host wins; an unknown host is inconclusive; only all stopped/absent hosts prove death. The classifier's active ID and work evidence follow the confirmed host. Real Workers controls cover stopped-first/running-second and stopped-plus-unknown.
- Security review found a concurrent restart generation could be adopted by an old stop attempt. Sleep now carries the generation observed with its owner, checks D1 identity immediately before dispatch, sends that exact expected generation, and fences workspace/agent/task/event and snapshot mutations. A proven change blocks the exact old claim immediately; its notice leaves the successor's chat/task/runtime alone. Full, fallback and explicit entry points all end that old intent, never retrying against the successor.
- 59 sleep integration tests pass, including all three entry points across before dispatch, VM generation rejection, after stop/before D1, and after D1/before snapshot finalization; each repeats the real sweep to prove no extra stop/release. External VM fixture corrections passed253 tests across six existing files; final Workers13 passed before generation correction. Final security review PASS; remaining root checks/Workers/staging/PR gates pending.
- Staging coordinator accepted a stopping-intent fault fixture only after a real VM stop if supported endpoints cannot force response loss. Real capture/R2, sweep, wake/prompt, old container absence and D1 agreement remain required; label exact callback-loss gap and clean up project/node to zero. One VM normal pool after T1; no production fault hook or pool changes.

## Final validation update
- Final root lint: 13 tasks passed; final root typecheck: 19 tasks passed. Full root tests rerunning sequentially on corrected external fixtures and final generation guards; root build pending.
- Surgical second revert removed only snapshot runtimeGuard: all three entry points failed the post-D1/pre-snapshot supersession assertions. Guard restored byte-for-byte; independent security review PASS.

## Post-mortem
- User-visible failure: a sleeping chat could not wake because its snapshot never acquired sleepingAt, while a stopped host continued to look live and emitted duplicate preservation records.
- Root causes: the stopping sweep aged its rows out in b291dce39 (#2223) without a running-workspace repair owner; the node heartbeat fan-out introduced in a08e9ceea refreshed assigned/running ACP rows independently of host status; the preservation-key LIKE introduced in 176385d9a (#2222) exceeded D1's pattern limit.
- Class: lost acknowledgement with incomplete convergence ownership, proxy/condition confusion, and mock-hidden database limits.
- Existing tests substituted lifecycle/database boundaries and did not combine the stale runtime, retained recovery point, node heartbeat, and real D1 dedupe shapes. This PR applies existing rules62/74 with real route/sweep/D1 tests and a revert-red proof; no additional standing rule is necessary.
