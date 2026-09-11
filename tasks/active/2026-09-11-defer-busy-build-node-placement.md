# Defer Busy Build Node Placement

## Problem

The TaskRunner rejects an otherwise-eligible reusable VM node when its heartbeat reports `creatingWorkspaces > 0`. That rejection is treated as a hard capacity failure, so placement returns no host and the scheduler proceeds to provision another VM even when the existing node has enough declared CPU, memory, disk, co-tenant, pool-authority, and agent-version capacity for the incoming workspace.

The vm-agent already serializes workspace builds per node with a build queue and reports queued/active creates through `creatingWorkspaces`. The control plane should interpret that signal as a bounded placement deferral only when it is the sole reason the host cannot accept work immediately.

## Research Findings

- `apps/api/src/services/workspace-resource-capacity.ts` currently returns `admitted: false` with reason `node is already creating a workspace` from the same measured-admission path as stale telemetry, pressure thresholds, malformed metrics, and unsupported versions.
- `apps/api/src/durable-objects/task-runner/node-selection.ts` builds host diagnostics and returns `null` when no admitted host exists, causing `handleNodeSelection` to fall through to `node_provisioning`.
- `apps/api/src/durable-objects/task-runner/node-provisioning-step.ts` already re-runs reusable-node selection before and after acquiring the VM provisioning lease, but the busy-build rejection still makes it provision after every wake.
- `apps/api/src/services/vm-admission-control.ts` and `node-provisioning-admission.ts` already provide the durable wait primitive, task mirror fields, retry alarms, and placement queue diagnostics. The new busy-build wait should reuse these with a shorter dedicated deadline.
- `packages/shared/src/types/placement-diagnostics.ts` already exposes a queue diagnostic block and host outcome/reasons. It needs a deferrable host outcome or equivalent inspectable state for this case.
- `packages/vm-agent/internal/server/server.go` hardcodes the per-node build semaphore depth with `make(chan struct{}, 1)`. This limit needs a `Default*` constant and env override while preserving the default depth of 1.
- Rollout compatibility: old agents already report `creatingWorkspaces`; agents that predate any new queue-depth field must remain acceptable. The control-plane behavior must not require new vm-agent fields to defer safely.

## Implementation Checklist

- [ ] Add a deferrable admission outcome for the sole `creatingWorkspaces > 0` case without weakening real CPU, memory, disk, co-tenant, exclusivity, telemetry freshness, agent version, or pool-authority rejections.
- [ ] Teach reusable-node selection to record deferrable hosts separately in placement diagnostics and expose that state to the TaskRunner step handler.
- [ ] Add a dedicated env-configurable busy-build wait budget with a `DEFAULT_*` constant; do not reuse the two-hour provider wait deadline for this reason.
- [ ] Reuse `waitForVmAdmissionCapacity`/`scheduleAdmissionWait` to park the task, keep it in the node-selection/provisioning retry flow, and let expiry fall through to normal provisioning rather than failing.
- [ ] Ensure a permanently busy node cannot re-park the same task forever; stale telemetry and the bounded budget must both provide escape paths.
- [ ] Add distinct queue and host diagnostic reason codes/strings for busy-build deferral.
- [ ] Make vm-agent build queue depth configurable with a default of 1 and tests for default, override, invalid override, and old-agent heartbeat compatibility.
- [ ] Update env examples and shared exports for the new control-plane setting.

## Acceptance Criteria

- [ ] A placement test enters through the TaskRunner path with one otherwise-eligible host reporting `creatingWorkspaces > 0`; it proves no node is provisioned and the task parks. The test is verified red against pre-fix code.
- [ ] A control test proves a busy host that also fails a real resource/capacity constraint is rejected and provisioning proceeds.
- [ ] A wake test proves placement re-runs after the build slot frees and lands the workspace on the existing node.
- [ ] A bounded-escape test proves a task provisions after the busy-build wait budget expires and does not fail.
- [ ] A stale-telemetry test proves `creatingWorkspaces > 0` on stale metrics follows the existing stale-telemetry rejection instead of parking.
- [ ] A two-tick zombie test proves a permanently-building node does not re-park the same task forever.
- [ ] Go tests cover configurable build-queue depth, default depth 1, invalid override fallback, and heartbeat compatibility when no new field is reported.

## References

- `apps/api/src/services/workspace-resource-capacity.ts`
- `apps/api/src/durable-objects/task-runner/node-selection.ts`
- `apps/api/src/durable-objects/task-runner/node-steps.ts`
- `apps/api/src/durable-objects/task-runner/node-provisioning-admission.ts`
- `apps/api/src/services/vm-admission-control.ts`
- `packages/shared/src/types/placement-diagnostics.ts`
- `packages/vm-agent/internal/server/server.go`
- `packages/vm-agent/internal/server/workspaces.go`
- `packages/vm-agent/internal/server/health.go`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/03-constitution.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `apps/api/.claude/rules/47-control-loop-io-budget.md`
- `apps/api/.claude/rules/69-aggregate-capacity-at-final-reservation.md`
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
