# Authoritative wake-ready prompt delivery

SAM task: 01M4AXGMEWDEH8KRRQ4X0CW824. Source Idea: 01M0VZ205TN8A1JYHNJN77DS4F.

## Problem and scope

Queued prompts can wait saturated retry backoff after VM/Instant recovery completes. Wake progress broadcasts and Instant D1 recovery writes do not schedule delivery. Own delivery readiness, not sibling persisted runtime configuration/ACP semantics, warm pools, retention or snapshot optimization.

## Research

- Latest main 294556e89; no overlapping open implementation PR at initialization.
- VM wake-progress-notifier/state-machine publishes cosmetic restored notifications, including superseded runner path; readiness must validate recovery task/attempt and current runtime binding.
- Instant vm-agent-container recovery commits incarnation-fenced D1 state and lifecycle under lock. Signal after that commit, not on ordinary healthy reconciliation.
- Existing nudgePromptDeliveriesForTarget moves queued/retry_wait deadlines; preparing claims can subsequently overwrite the nudge with backoff. Retain an attempt-fenced marker and consume it only for a pre-send not_ready retry.
- Preparation has a configurable 5-second budget and intentionally cannot submit after timeout. Capability GET timeout currently marks runtime interrupted even after successful wake; disable recovery-on-timeout for that read-only request only.
- Existing claim/submission/receipt fences and admission stay authoritative. Failed signaling falls back to existing bounded retries/TTL.
- Full Idea and library sleep-wake-performance.md read. Scoped DO concurrency/control-loop rules apply.

## Checklist

- [x] Add D1-authority-validated, runtime/recovery-attempt-fenced readiness RPC with duplicate suppression.
- [x] Immediately schedule eligible deliveries, preserving original ordering and preparing-timeout races without touching possible-send claims.
- [x] Connect committed VM and Instant wakes; preserve cancellation/replay/admission safeguards.
- [x] Fix proven capability timeout race using existing transport option.
- [x] Add phase timestamps and deterministic saturated-backoff/duplicate/stale/race tests.
- [x] Update affected docs and source Idea.
- [ ] Run applicable lint/typecheck/tests/build and independent specialist reviews.
- [ ] Coordinate pinned staging with siblings/occupants; measure user-message→ready→actual prompt start for both runtimes, verify no residual retry wait, clean owned resources.
- [ ] Validate task completion, archive evidence, create PR, pass CI and best-effort CodeRabbit, merge and verify production deployment.

## Acceptance

Current committed wake schedules eligible prompt delivery at configured minimum alarm delay despite saturated backoff. Duplicate/stale signals cannot release new work or replay submissions. Readiness preceding preparation timeout is retained exactly once. Ordering, receipts, cancellation and admission remain enforced. Live VM/Instant evidence includes timestamps and cleanup; CI/reviews/merge SHA/deployment proof recorded.

## Review and test evidence

- Independent Cloudflare/constitution reviewer PASS after fixing authority-read interleaving, moving VM signal before optional chat feedback, and preserving FIFO across transient retry_wait. Both claim and alarm use the same predecessor predicate; urgency priority is unchanged.
- Independent test reviewer verified Workers 3/3 and targeted SQL/adapter 103/103, then requested stronger timeout/hook/fairness coverage. Added actual five-second capability timeout test (15 transport tests pass), VM/Instant hook tests (58 pass), independent-target and no-immediate-alarm-loop regressions.
- Full lint/typecheck/build/tests and latest Workers run still pending. An initial concurrent root test/build invocation raced Astro's shared data-store temp file; rerun root tests after build completes, without source changes for that harness artifact.
- No new polling or global retry interval change. Readiness RPC reuses WAKE_PROGRESS_BROADCAST_TIMEOUT_MS. Candidate selection narrows to one active delivery per target and excludes pending predecessors; existing maxCandidatesPerAlarm, receiptTimeoutMs and TTL bound work. Each authority check is one indexed D1 read, then local SQLite updates and existing alarm recalculation. No VM provisioning added.
- Archive only after final task-completion validation with coordinated staging evidence; CI/merge/production proof remain required.

Latest focused Workers run: 6/6 (readiness vertical slices + preparation fences). Full typecheck 19 tasks pass; full build 9 tasks pass. Full lint only failed import sorting in changed timeout transport test, autofixed; rerun pending.

Final local validation updates: full lint13 tasks, typecheck19 tasks, build9 tasks PASS. Full root test run passed20 other package tasks; API818/821files and11491/11500tests passed. Focused rerun isolates six integration fixture failures (missing ctx.waitUntil/ProjectData readiness RPC and obsolete concurrent same-target expectation); fixed fixture now22/22PASS independently. Other two suites94 tests pass on focused rerun after import-pressure timeouts. Full API rerun with8 workers in progress.

Rule45 mutation proof: in an isolated worktree bypassing wakeReadyLock, strengthened deferred-D1 test fails expected reads1 vs actual2 at entry. Original completion-count assertion did not discriminate; readIndex now increments before D1 await. Production mutex unchanged. Independent test-engineer final review PASS and independently reran Instant integration22/22. Temporary mutation worktree removed.
