# Fix provisioning node cleanup race

## Problem Statement

The incompatible-vm-agent cleanup sweep can destroy a newly provisioned VM before its
agent reports a build version. The TaskRunner has already claimed the node for an
active task, but the sweep treats `agent_version IS NULL` as an idle incompatible node
when no workspace exists yet. Once the row is marked deleted, TaskRunner continues
polling it until the 15-minute readiness timeout instead of reporting that the node is
gone.

Production session `696a21e7-84d1-4080-9060-a77302a7ffc9` hit this exact race on
2026-08-07. Node `01KZEFRXPQ3XNCYZQK0N6ZT0BM` was created at
`2026-08-07T16:09:20.855Z` and destroyed 65 seconds later by
`incompatible_vm_agent_cleanup` while `agent_version` was still `NULL`. Its task
remained queued at `node_agent_ready`, pointing at the deleted node.

## Research Findings

1. `sweepIncompatibleVmAgentNodes()` in
   `apps/api/src/scheduled/node-cleanup/node-phases.ts` selects every managed running
   workspace VM whose agent version is null or different from the required version.
   It only protects active workspaces; it has no boot-age guard and does not check
   `tasks.auto_provisioned_node_id` for an active provisioning claim.
2. The destructive query was introduced by commit `50af27fac` on 2026-08-06. Existing
   rollout tests cover old non-null versions, active workspaces, and Instant nodes, but
   not the pre-heartbeat state where `agent_version` is null and a task owns the node.
3. `handleNodeProvisioning()` and `handleNodeAgentReady()` in
   `apps/api/src/durable-objects/task-runner/node-steps.ts` do not distinguish a
   missing/deleted node from one that is still booting. Both paths can poll until their
   timeout after another control loop destroys the node.
4. The existing node cleanup configuration already provides a configurable idle grace
   (`NODE_ORPHAN_IDLE_TIMEOUT_MS`). It can guard unversioned nodes without adding a
   hardcoded duration. An active task claim is the stronger lifecycle ownership gate.
5. Candidate volume remains bounded by `NODE_CLEANUP_SWEEP_LIMIT`. The added checks are
   D1-only. Skipped task claims have a bounded escape path because TaskRunner
   provisioning/readiness timeouts terminalize the task; fresh null-version nodes age
   past the configured grace.
6. Exact-SHA rollout compatibility and the broader scheduling policy remain unchanged.
   This hotfix addresses the destructive lifecycle race, not rollout redesign.
7. Production also shows a separate recurring `LIKE or GLOB pattern too complex`
   failure in the stuck-task sweep. That is deferred to
   `tasks/backlog/2026-08-07-fix-stuck-task-sweep-pattern-complexity.md` so it does not
   expand this urgent lifecycle hotfix.

## Implementation Checklist

- [ ] Add a production-shaped SQLite regression proving an active task claim protects a
      running, unversioned VM with zero workspaces.
- [ ] Add a regression proving a fresh unversioned VM is protected during the
      configurable boot/idle grace even without a task claim.
- [ ] Keep old, unclaimed, mismatched VM nodes eligible for cleanup after the guard.
- [ ] Add active task ownership and fresh-unversioned age guards to the incompatible
      vm-agent cleanup phase while retaining role, class, runtime, and workspace gates.
- [ ] Detect missing/deleted claimed nodes in TaskRunner provisioning and agent-ready
      steps, preserve diagnostic identity, disable warm-pool cleanup for the already
      gone node, and fail immediately with an actionable error.
- [ ] Add TaskRunner regressions for both provisioning and agent-ready disappearance.
- [ ] Update `.claude/rules/54-vm-agent-rollout-compatibility.md` so future destructive
      rollout cleanup must protect active provisioning claims and pre-heartbeat grace.
- [ ] Record local validation, specialist review, CI, and the user-directed staging skip.

## Acceptance Criteria

- An active queued/delegated/in-progress task whose `auto_provisioned_node_id` points to
  a running VM prevents incompatible-agent cleanup from destroying that VM before its
  workspace exists.
- A running VM with `agent_version IS NULL` is not eligible for incompatible-agent
  cleanup until it is older than the configured idle grace.
- An old, idle, unclaimed VM with a non-matching reported agent version is still reaped.
- TaskRunner fails on the next poll with a node-disappeared diagnostic when its claimed
  node is missing or marked deleted; it does not wait for the full readiness timeout or
  schedule another poll.
- Failure cleanup does not return an already deleted/missing node to the warm pool.
- Regression tests exercise realistic node, task, and workspace relationships and fail
  against the pre-fix behavior.
- Cleanup candidate volume remains bounded, adds no network I/O, and every new skipped
  state has a time- or lifecycle-bounded escape path.
- The task record contains a complete post-mortem and the same PR includes a durable
  process guard for this class of lifecycle race.
- Lint, typecheck, tests, build, specialist reviews, and GitHub CI pass. Staging is not
  deployed because the user explicitly prohibited it.

## Post-Mortem

### What broke

New task sessions could lose their freshly provisioned VM about one minute after node
creation, then remain visibly stuck in provisioning until a 15-minute timeout.

### Root cause

Commit `50af27fac` introduced exact-build rollout cleanup and modeled safety only in
terms of active workspaces. During cold provisioning there is intentionally no
workspace yet and `agent_version` is null until the first ready/heartbeat callback, so
the destructive sweep interpreted the normal pre-heartbeat state as an idle legacy VM.
The TaskRunner independently assumed its claimed node row would remain present and
treated missing/deleted rows as "still creating/not ready."

### Timeline

- 2026-08-06 13:57 UTC: commit `50af27fac` introduced the incompatible-agent sweep.
- 2026-08-07 16:09 UTC: the reported session provisioned its medium VM.
- 2026-08-07 16:10 UTC: cleanup destroyed that VM 65 seconds after creation.
- 2026-08-07: the production scheduling/session investigation identified the race.

### Why it was not caught

Tests covered reported stale versions and busy nodes with established workspaces, but
not the cross-control-loop transition between node creation and first agent heartbeat.
No regression constructed the real D1 relationship where an active task owns an
unversioned node before any workspace row exists. TaskRunner tests likewise modeled
creating/running/error nodes but not deletion by a concurrent sweep.

### Class of bug

A destructive lifecycle race caused by using downstream activity (workspace existence)
as the only ownership signal while an upstream state machine already owns the resource.
The cleanup and provisioning control loops each had locally plausible assumptions that
were invalid when interleaved.

### Process fix

Extend `.claude/rules/54-vm-agent-rollout-compatibility.md` to require destructive
rollout cleanup to protect active provisioning claims, preserve a configurable
pre-heartbeat grace, and include a production-shaped interleaving regression with a
task-owned unversioned node and no workspace.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/51-server-side-node-class-gates.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`
- `apps/api/src/scheduled/node-cleanup/node-phases.ts`
- `apps/api/src/durable-objects/task-runner/node-steps.ts`
