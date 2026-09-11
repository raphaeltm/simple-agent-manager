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

- [x] Add a deferrable admission outcome for the sole `creatingWorkspaces > 0` case without weakening real CPU, memory, disk, co-tenant, exclusivity, telemetry freshness, agent version, or pool-authority rejections.
- [x] Teach reusable-node selection to record deferrable hosts separately in placement diagnostics and expose that state to the TaskRunner step handler.
- [x] Add a dedicated env-configurable busy-build wait budget with a `DEFAULT_*` constant; do not reuse the two-hour provider wait deadline for this reason.
- [x] Reuse `waitForVmAdmissionCapacity`/`scheduleAdmissionWait` to park the task, keep it in the node-selection/provisioning retry flow, and let expiry fall through to normal provisioning rather than failing.
- [x] Ensure a permanently busy node cannot re-park the same task forever; stale telemetry and the bounded budget must both provide escape paths.
- [x] Add distinct queue and host diagnostic reason codes/strings for busy-build deferral.
- [x] Make vm-agent build queue depth configurable with a default of 1 and tests for default, override, invalid override, and old-agent heartbeat compatibility.
- [x] Update env examples and shared exports for the new control-plane setting.

## Acceptance Criteria

- [x] A placement test enters through the TaskRunner path with one otherwise-eligible host reporting `creatingWorkspaces > 0`; it proves no node is provisioned and the task parks. The test is verified red against pre-fix code.
- [x] A control test proves a busy host that also fails a real resource/capacity constraint is rejected and provisioning proceeds.
- [x] A wake test proves placement re-runs after the build slot frees and lands the workspace on the existing node.
- [x] A bounded-escape test proves a task provisions after the busy-build wait budget expires and does not fail.
- [x] A stale-telemetry test proves `creatingWorkspaces > 0` on stale metrics follows the existing stale-telemetry rejection instead of parking.
- [x] A two-tick zombie test proves a permanently-building node does not re-park the same task forever.
- [x] Go tests cover configurable build-queue depth, default depth 1, invalid override fallback, and heartbeat compatibility when no new field is reported.

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


## Implementation Notes

- Added `WORKSPACE_BUSY_BUILD_QUEUE_REASON` and a `deferrable` result on workspace reservation admission. A host is deferrable only when that busy-build reason is the sole admission reason, so real budget, co-tenant, exclusivity, telemetry freshness, agent-version, and pool-authority failures remain hard rejections.
- Added `findReusableNodePlacement` as the richer reusable-node selector while preserving `findNodeWithCapacity` for provisioning-step reuse. The richer selector records busy-build-only hosts as `outcome: 'deferred'` in placement diagnostics and returns a deferrable result when no admitted host exists.
- Updated TaskRunner node selection to park busy-build deferrals through `waitForVmAdmissionCapacity`/`scheduleAdmissionWait` using the distinct reason `compatible_node_building_workspace`. Expiry records the same queue reason in placement diagnostics and advances to normal provisioning instead of failing.
- Added `DEFAULT_VM_ADMISSION_BUSY_BUILD_WAIT_TIMEOUT_MS` at 20 minutes and env `VM_ADMISSION_BUSY_BUILD_WAIT_TIMEOUT_MS`. The wait primitive now accepts an optional per-call timeout, reuses existing deadlines only for the same admission reason, and uses the admission row's original `enqueued_at` to avoid extending the busy-build budget across repeated wakes.
- Passed `WORKSPACE_BUILD_QUEUE_DEPTH` through API env, wrangler, cloud-init, and vm-agent config. The vm-agent default remains 1, invalid or over-max env values fall back during load, validation rejects out-of-range direct config values, and the server constructor defensively defaults direct/legacy zero values to 1.
- Updated env reference and VM-agent docs for the new variables.

## Red/Green Evidence

Red proof before the implementation:

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/task-runner-node-selection.test.ts` failed with 4 red assertions. The new busy-build placement test observed `waitForVmAdmissionCapacity` was never called, the wake test advanced to `node_provisioning` on the first tick, the bounded-expiry test had no queue diagnostic, and the two-tick zombie test never parked. This is the pre-fix behavior that provisions instead of deferring.

Local validation after the final diff:

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/task-runner-node-selection.test.ts tests/unit/services/workspace-resource-capacity.test.ts` — passed as part of the targeted API command, 36 tests.
- `cd apps/api && pnpm exec vitest run --config vitest.workers.config.ts tests/workers/vm-admission-control-races.test.ts` — passed, 1 worker file / 24 tests.
- `pnpm --filter @simple-agent-manager/cloud-init test -- tests/generate.test.ts` — passed, 209 tests.
- `pnpm typecheck` — passed, 19 tasks.
- `pnpm check:fast` — passed, with existing unrelated ESLint warnings only.
- `pnpm test` — passed, 21 tasks; API 711 files / 9644 tests, web 308 files / 3747 tests.
- `git diff --check` — passed.

Go validation note:

- Added Go tests for `WORKSPACE_BUILD_QUEUE_DEPTH` default, override, invalid override fallback, server queue concurrency, and old-agent heartbeat compatibility. This workspace image does not include `go` or `gofmt`, and has no `mise`/`asdf` wrapper, so Go tests could not be executed locally. CI must run them.


## Specialist Review Follow-up

- Go review found no blockers and requested an upper bound for direct `WORKSPACE_BUILD_QUEUE_DEPTH` env usage plus constructor wiring coverage. Fixed by adding `MaxWorkspaceBuildQueueDepth`, bounded load/validation, a same-package helper test, and a `server.New(cfg)` constructor test that asserts the actual `buildQueue` capacity.
- Architecture/performance/Cloudflare reviews found the short busy-build `wait_deadline_at` could poison later provider/provisioning waits. Fixed by reusing existing admission deadlines only when the existing admission reason matches the current wait reason; added a D1-backed worker regression where an expired busy-build row falls through to provider admission with a fresh provider deadline.
- Architecture review found busy-build could mask simultaneous measured CPU/memory/disk pressure because the measured diagnostic short-circuited before pressure checks. Fixed by letting live pressure checks win before busy-build deferral; added a regression where `creatingWorkspaces > 0` plus high memory pressure is rejected, not deferred.
- Cloudflare review requested checked-in Worker config for `VM_ADMISSION_BUSY_BUILD_WAIT_TIMEOUT_MS`. Added it to top-level `[vars]` in `apps/api/wrangler.toml`. The optional GitHub Environment override allowlist in `scripts/deploy/sync-wrangler-config.ts` was intentionally left untouched because the task explicitly reserved that file for a sibling PR; deploy generation already copies checked-in top-level vars.

- Focused re-reviews from cloudflare-specialist, go-specialist, test-engineer, architecture review, and performance review all passed after the blocker fixes.
