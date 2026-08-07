# Pre-Destroy Safe Evidence Capture for Reaped Nodes

## Problem

When node cleanup reaps a node (stale heartbeat, max lifetime, incompatible build, stopped handoff), `destroyNodeForCleanup` (`apps/api/src/scheduled/node-cleanup/shared.ts:200`) destroys the VM without capturing any evidence. The operator-grade debug package is unreachable exactly when it is most needed: every node diagnostic route is hard-gated on `status === 'running'`, so a failed-then-reaped node leaves behind only the narrow error-triggered incident snapshot (if an error-level report fired while the agent was alive).

Raphaël has explicitly prioritized preserving VM evidence at incident time before the node becomes unreachable or is destroyed.

## Constraints (policy)

- The broad debug package must remain explicit operator-only and must NEVER be automatically retained, model-ingested, or sent upstream.
- Any automatic artifact must use the existing safe allowlisted collector + recursive redaction framework (`packages/vm-agent/internal/errorreport/`), with canary-secret tests proving absence from stored artifacts.
- Cleanup sweeps have I/O budgets (rule 47): a capture attempt against a dead agent must use a short background timeout and never block the sweep; every candidate needs an escape path.

## Direction

1. When the cleanup sweep selects a node for destruction with a non-clean cause (stale heartbeat, error status, incompatible build with active work drained), attempt a bounded "final safe snapshot" request to the vm-agent (short timeout, one attempt, fire-and-forget) BEFORE destroy; proceed with destroy regardless of outcome.
2. Additionally, vm-agent self-captures a safe snapshot when it detects its own heartbeat delivery failing repeatedly (evidence survives via the existing durable outbox → R2 path even if the control plane never reaches it again).
3. Surface "final snapshot" incidents in the admin per-node incident view.

## Acceptance Criteria

- [ ] A node reaped for staleness/error has a safe incident snapshot in R2/D1 when the agent was reachable at reap time (or had self-captured on heartbeat failure).
- [ ] Sweep wall-time budget unchanged in the dead-agent case (short timeout, no retry inside the sweep).
- [ ] Canary-secret suite covers the new capture triggers.
- [ ] Broad debug package remains untouched by any automatic path.

## References

- `tasks/active/2026-08-07-debugging-experience-overhaul.md` (origin of this follow-up)
- `tasks/active/2026-08-05-complete-local-debugging-experience.md` (safe snapshot framework)
- `.claude/rules/47-control-loop-io-budget.md`, `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
