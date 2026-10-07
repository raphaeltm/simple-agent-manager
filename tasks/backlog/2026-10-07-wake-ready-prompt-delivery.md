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
- [ ] Add D1-authority-validated, runtime/recovery-attempt-fenced readiness RPC with duplicate suppression.
- [ ] Immediately schedule eligible deliveries, preserving original ordering and preparing-timeout races without touching possible-send claims.
- [ ] Connect committed VM and Instant wakes; preserve cancellation/replay/admission safeguards.
- [ ] Fix proven capability timeout race using existing transport option.
- [ ] Add phase timestamps and deterministic saturated-backoff/duplicate/stale/race tests.
- [ ] Update affected docs and source Idea.
- [ ] Run applicable lint/typecheck/tests/build and independent specialist reviews.
- [ ] Coordinate pinned staging with siblings/occupants; measure user-message→ready→actual prompt start for both runtimes, verify no residual retry wait, clean owned resources.
- [ ] Validate task completion, archive evidence, create PR, pass CI and best-effort CodeRabbit, merge and verify production deployment.

## Acceptance
Current committed wake schedules eligible prompt delivery at configured minimum alarm delay despite saturated backoff. Duplicate/stale signals cannot release new work or replay submissions. Readiness preceding preparation timeout is retained exactly once. Ordering, receipts, cancellation and admission remain enforced. Live VM/Instant evidence includes timestamps and cleanup; CI/reviews/merge SHA/deployment proof recorded.
