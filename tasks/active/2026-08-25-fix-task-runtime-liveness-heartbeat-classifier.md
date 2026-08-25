# Fix task runtime liveness heartbeat classifier

## Problem

`classifyTaskRuntimeLiveness` treated a stale node heartbeat as conclusive runtime death for VM workspaces. Under CPU starvation from concurrent devcontainer builds, a healthy VM agent can stop heartbeating for several minutes while the node still has running workspaces. The stuck-task sweep then tears down active work.

## Research findings

- `apps/api/src/services/task-runtime-liveness.ts` is the shared pure classifier used by the cron sweep and ProjectData adapter.
- `apps/api/src/scheduled/stuck-tasks.ts` previously returned immediately when the pure classifier produced `node_not_live`, so no direct VM-agent probe could run.
- Rule 47 requires short, env-configurable control-loop I/O budgets. The node health probe must not inherit the 30s interactive VM-agent timeout.
- Rule 53 applies because heartbeat is a liveness timestamp, not definitive death evidence under SAM-created CPU load.
- Rule 58 applies because destructive terminal verdicts need stronger evidence than a status/timestamp that can diverge from recoverability.

## Implementation checklist

- [x] Add task-liveness-specific default probe timeout constant and env field.
- [x] Add node health probe outcome and running-workspace count to classifier signals.
- [x] Keep terminal node status as conclusive death.
- [x] Make stale heartbeat inconclusive unless a short direct VM-agent health probe fails.
- [x] Wire the scheduled stuck-task adapter to probe `/health` only for stale VM nodes that would otherwise be terminalized.
- [x] Keep the ProjectData local adapter conservative by supplying `not_run` and preserving stale-heartbeat candidates.
- [x] Add regression tests for stale heartbeat with running workspaces, failed probe, successful probe, and short timeout default/override.

## Acceptance criteria

- [x] Stale heartbeat with running workspaces returns inconclusive before/without a failed probe.
- [x] Stale heartbeat with no running workspaces and a failed direct probe remains conclusive death.
- [x] Stale heartbeat with running workspaces and successful probe remains inconclusive.
- [x] Probe timeout defaults to 5 seconds and is env-configurable.

## References

- `apps/api/src/services/task-runtime-liveness.ts`
- `apps/api/src/scheduled/stuck-tasks.ts`
- `packages/shared/src/constants/defaults.ts`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
