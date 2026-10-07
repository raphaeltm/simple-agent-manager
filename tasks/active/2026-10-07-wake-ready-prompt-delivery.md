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
- [x] Run applicable lint/typecheck/tests/build and independent specialist reviews.
- [ ] Coordinate pinned staging with siblings/occupants; measure user-message→ready→actual prompt start for both runtimes, verify no residual retry wait, clean owned resources.
- [ ] Validate task completion, archive evidence, create PR, pass CI and best-effort CodeRabbit, merge and verify production deployment.

## Acceptance

Current committed wake schedules eligible prompt delivery at configured minimum alarm delay despite saturated backoff. Duplicate/stale signals cannot release new work or replay submissions. Readiness preceding preparation timeout is retained exactly once. Ordering, receipts, cancellation and admission remain enforced. Live VM/Instant evidence includes timestamps and cleanup; CI/reviews/merge SHA/deployment proof recorded.

## Review and test evidence

- Independent Cloudflare/constitution reviewer PASS after fixing authority-read interleaving, moving VM signal before optional chat feedback, and preserving FIFO across transient retry_wait. Both claim and alarm use the same predecessor predicate; urgency priority is unchanged.
- Independent test reviewer PASS: Workers/SQL/adapter tests independently verified, final Instant integration22/22 independently rerun. Exact producer-hook coverage58/58 and actual five-second capability transport timeout15/15 pass. Independent-target and no-immediate-alarm-loop regressions preserve useful alarm scheduling.
- Full lint13 tasks, typecheck19 tasks and build9 tasks PASS. Full API821 files/11500 tests PASS with8 workers (128.21s); other20 root test tasks passed. An initial parallel root test/build invocation raced Astro's shared temp file; the sequential build/test rerun resolved that harness artifact. Import-pressure timeouts passed focused reruns with no production changes.
- Final readiness Workers3/3 PASS; unchanged preparation Workers3/3 previously PASS. The existing Instant vertical fixture now models real ctx.waitUntil and fenced ProjectData readiness RPC against actual migrated SQLite; ordered same-target admission replaces its obsolete concurrent-preparation expectation.
- Rule45 discrimination: isolated wakeReadyLock bypass fails expected1 versus actual2 authority-read entries. The strengthened test counts entry before D1 await; intact mutex passes, failed authority reads do not wedge the chain. Temporary mutation worktree removed; no mutation entered the branch.
- No new polling or global retry interval change. Readiness RPC reuses WAKE_PROGRESS_BROADCAST_TIMEOUT_MS. Candidate selection narrows to one active delivery per target and excludes pending predecessors; existing maxCandidatesPerAlarm, receiptTimeoutMs and TTL bound work. Each authority check is one parameterized D1 read, then local SQLite updates and existing alarm recalculation. No VM provisioning added by implementation.

## Operational evidence

Reviewed source commit dc18fa816; final regression commit827ed4bd2; validation evidence0498e292e. Source Idea updated without marking broader deferred scope complete. Shared staging coordinator owns pinned combined deployment with runtime-contract and archive siblings. Occupant webhook run37607076979 and manual verification/cleanup recorded successful in PR2260; handoff coordination continues. Contract sibling reconciles its unapplied D1 migration0184→0185 against applied webhook0184; own ProjectData migration061 has no collision.

Staging timestamps, cleanup, final task-completion validation/archive, PR/CI/CodeRabbit, merge and production deployment proof remain pending. Archive only after final task-completion validation with coordinated staging evidence.

Live staging run37611247210 succeeded including smoke on combined3c9792edd, then a conflicting webhook deployment37613801900 overwrote the claimed environment: independently verified Cloudflare active342740d0 at100% from11:32:19, replacing validatedbf2f0be9. Parent coordinates restoration; all new sleep/wake/flag/cleanup mutations paused and resources preserved. Prior owned Instant task01M4B1WMXBKPP3FF2Q37GBDP0V failed11:27:39 before overwrite: generated new task branch absent upstream during standalone clone; contract sibling owns task-semantic diagnosis, no blind redispatch. Shared owned project01M4B1N63Q5XE39D9SCQHSNDBH and existing VM/Instant records preserved. Read-only authenticated Playwright dashboard/project/settings navigation succeeded without page errors. Wake latency proof remains pending; real start will use Go `ACP Prompt started` lifecycle report keyed by deliveryId, since session state can synthesize promptStartedAt from acceptance.

### Verified Instant staging evidence

Final combined candidate `a1d340864b580dbe28d00a051c2f309aa02370cc`, staging run37617669770 PASS including smoke. Coordinator verified API5a86cabc/web415df321/VM-agent1f7b6c0b2 binary provenance; approved flag-only mutation changed version to a7db0912 with unchanged code ETagfd387f25. Latest main2aa6ceac5 reconciled cleanly; post-reconciliation Workers3/3 PASS.

[Bounded redacted source evidence](../evidence/2026-10-07-wake-ready-delivery/instant.json) records the original Sol model/effort/task contract, exact delivery IDs, readiness producer log, actual Go ACP lifecycle rows, retry/acceptance activity and terminal deliveries. A user1791375784163 → ready1791375803660 → actual ACP1791375805929: 19.497s recovery, 2.269s ready→start, 21.766s total. Its old retry deadline1791375810169 was bypassed by4.240s. Signal completed1791375803869 and released2 deliveries. B actual ACP1791375836805 followed A; both exact tokens appeared in order, both acked with nextAttemptAt null, session idle/task awaiting_followup. B busy retries while A ran its harmless sleep are expected admission safeguards, not residual wake retry. Runtime sibling now owns same-session callback/git/completion proof; cleanup follows its release.

Artifacts-only failed fixture task/profile cleanup200 after preserved diagnosis and explicit parent replacement approval. One replacement GitHub-backed Instant task01M4B4YQ4F2HF0YX5Q62MGFVPN/profile01M4B4YC23EYXEPR5DA299H9V4 preserves gpt-6.1-sol/auto/task; no unsupported VM-only retry route, no model override or extra VM. Original VM wake capture remains pending runtime provisioning; bounded120s read-only capture ended with evidence preserved and no cancellation.
