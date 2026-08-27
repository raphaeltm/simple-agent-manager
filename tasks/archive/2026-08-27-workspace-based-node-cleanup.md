# Workspace-based node cleanup idleness

## Problem

Node cleanup still treats `tasks.status IN ('queued', 'delegated', 'in_progress')` as active node
work in the final CAS claim. That permanently pins auto-provisioned workspace nodes that hosted a
sleeping session: the task remains `in_progress` so the conversation can wake, but the hardware
has no active workspace and no useful work to perform.

Raphaël's explicit direction on 2026-08-27: the workspace represents work being done on the
hardware. A task's `in_progress` status is about the session, not the node. A waking session
provisions a fresh node or claims a warm one from its snapshot, so a workspace-less node only burns
Hetzner billing. Hetzner bills stopped servers too.

Production evidence: five stopped medium nodes hosting sleeping sessions sat idle for 2–16 hours.
The sleep path correctly marks nodes idle (`session-sleep.ts`, `session-snapshot-upload-relay.ts`)
and NodeLifecycle hands warm nodes off as `status='stopped'` after `NODE_WARM_TIMEOUT_MS`, but every
cron destroy path funnels through `claimNodeForCleanup()`, whose task-status guard rejects the
candidate forever.

## Research findings

- `apps/api/src/scheduled/node-cleanup/shared.ts`
  - `claimNodeForCleanup()` is the final CAS for every node destroy phase.
  - It already gates on `node_role = 'workspace'`, `node_class != 'user-owned'`, and no active
    workspaces unless `allowActiveWorkspaces` is set.
  - Its `NOT EXISTS tasks ... status IN ('queued','delegated','in_progress')` is the pinning bug.
  - `LAST_WORKSPACE_ACTIVITY_SQL = COALESCE(MAX(w.updated_at), n.created_at)` is the required
    idleness clock and must remain the idleness source instead of `nodes.updated_at`.
- `apps/api/src/scheduled/node-cleanup/node-phases.ts`
  - Stale warm, max-lifetime, stopped-handoff, incompatible VM-agent, and idle-orphan phases all
    route actual node deletion through `destroyNodeForCleanup()`.
  - Stopped handoff already selects the incident shape (`n.status='stopped'` plus
    `tasks.auto_provisioned_node_id = n.id`); the final claim is what loses.
  - `sweepIncompatibleVmAgentNodes()` has a sibling task-status predicate
    (`active_task_claim`) that currently creates an indefinite rollout-cleanup exemption. It should
    become the same bounded workspace-activity/created-at grace.
  - `sweepTerminalCfContainers()` uses a workspace-scoped active-task guard for terminal
    cf-container cleanup; it is not a node-idleness exemption and should remain.
- `apps/api/src/durable-objects/node-lifecycle.ts`
  - `persistWarmClaim()` records `tasks.claimed_warm_node_id` under the
    `idx_tasks_claimed_warm_node_unique` partial index before clearing the DO warm alarm.
  - NodeLifecycle has no cleanup destroy task-status guard; its D1 write only marks a warm node
    `stopped` for cron handoff.
  - Workspace staged deletion is a real finalizer writer and must keep preserving restorable
    sleeping sessions.
- `apps/api/src/services/workspace-placement.ts`
  - `reserveWorkspacePlacement()` inserts the durable `creating` workspace row in one
    `INSERT ... SELECT` against a still-running workspace-role node.
  - Sequence for warm reuse is: NodeLifecycle warm claim records task claim and clears warm alarm,
    then TaskRunner calls `reserveWorkspacePlacement()` to create the workspace row. Therefore a
    bounded pre-row race remains; `COALESCE(MAX(w.updated_at), n.created_at)` closes it for fresh
    nodes by giving them the workspace-idle window from `nodes.created_at`.
- `apps/api/src/services/workspace-lifecycle-finalizer.ts`
  - PR #1937 centralized the restorable-snapshot guard in `finalizeProjectDataSession()`, mirroring
    `claimSessionSnapshotRecovery()`.
  - Both `destroyNodeForCleanup()` and NodeLifecycle staged deletion route through
    `finalizeWorkspaceLifecycleClosure()`, so regression tests should drive those real writers.
- Relevant incident/process lessons:
  - Rule 47: changed sweep predicates require a load review and a two-sweep escape test for
    permanently failing candidates.
  - Rule 51: every destroy/terminal-mutate candidate must keep server-side `node_role='workspace'`
    and `node_class!='user-owned'` gates.
  - Rule 53: idleness must not use `nodes.updated_at`; heartbeats rewrite it.
  - Rule 54 item 9: a recent `claimed_warm_node_id` placement before the workspace row exists needs
    a bounded protection window; `auto_provisioned_node_id` and task status alone are not activity.
  - Rule 58: teardown finalizers must not archive a session that the snapshot resumer can wake.
  - Rule 62: tests must reach the feature through the production writer/trigger.

## Implementation checklist

- [x] Add a dedicated env-configurable node workspace-idleness window with a shared
      `DEFAULT_*` constant, defaulting to 30 minutes and aligned with warm-timeout semantics without
      shortening warm retention.
- [x] Add shared SQL/utility for workspace-idle eligibility using
      `COALESCE(MAX(workspaces.updated_at), nodes.created_at)` and no `nodes.updated_at`.
- [x] Replace `claimNodeForCleanup()`'s blanket task-status exemption with workspace-based
      idleness: no active workspaces, no workspace activity for the configured window, and the
      existing role/class/status/user CAS gates.
- [x] Preserve the absolute-lifetime exception for stale active workspace rows, but require stale
      workspace activity there too.
- [x] Update node cleanup candidate queries so stopped handoff, stale warm, idle orphan, max
      lifetime, and incompatible rollout cleanup use the workspace-idle rule and retain
      `node_role='workspace'`, `node_class!='user-owned'`, and auto-provisioned scope where
      applicable.
- [x] Replace the sibling incompatible-rollout `active_task_claim` skip with the same bounded
      created-at/workspace-activity grace.
- [x] Keep 4h max-lifetime and 24h absolute ceiling backstops unchanged.
- [x] Prove the placement race: a fresh claimed node with no workspace row is not destroyed, and
      `reserveWorkspacePlacement()` creates a `creating` row that blocks cleanup by construction.
- [x] Add incident reproduction coverage: stopped/warm node, no active workspaces for the window,
      `tasks.auto_provisioned_node_id` on an `in_progress` task, and cleanup destroys the node.
- [x] Add controls for running/creating/recovery workspaces, recent workspace activity, deployment
      nodes, user-owned nodes, and fresh claimed nodes.
- [x] Add a two-sweep rule-47 test for a permanently failing destroy candidate.
- [x] Extend sleeping-session survival coverage through `destroyNodeForCleanup()` and
      NodeLifecycle staged deletion: snapshot row remains restorable, ProjectData session remains
      `sleeping`, and wake/recovery remains claimable.
- [x] Update Env/shared constants documentation and any source comments whose old wording says task
      status is node work.
- [x] Include the rule-47 load review in the PR: expected candidate volume is the current 5–10
      pinned nodes; steady state should be small; per-candidate cost is one D1 CAS plus strict
      provider/DNS teardown only for selected candidates, with existing failure backoff.

## Implementation notes

- Added `NODE_WORKSPACE_IDLE_TIMEOUT_MS` with default `DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS`
  (30 minutes). `NODE_ORPHAN_IDLE_TIMEOUT_MS` remains a legacy alias when the primary variable is
  unset.
- Added `tasks.claimed_warm_node_at` so warm-reuse pre-placement claims have a fixed bounded expiry
  independent of general `tasks.updated_at` progress writes.
- Added migration 0124 to rebuild the claim timestamp partial index with the cleanup guard's exact
  active-status predicate; 0123 remains unchanged because it had already reached staging.
- Rule 47 load review: the incident candidate volume is currently ~5–10 pinned nodes. Steady-state
  volume should be small because candidates need auto-provisioned ownership, workspace-role/managed
  gates, no active workspace, workspace-idle age, no recent warm-placement claim, and failure
  backoff escape after failed teardown.

## Acceptance criteria

- An auto-provisioned workspace-role managed node with no active workspaces and no workspace
  activity for the configured window is destroy-eligible regardless of task status.
- Sleeping sessions are not archived by either node-cleanup destroy or NodeLifecycle staged
  workspace deletion while a restorable snapshot exists.
- A subsequent sleeping-session wake can create/claim a recovery task after the old node has been
  destroyed.
- Fresh node placement/warm-reuse claims remain protected for a bounded grace before the workspace
  row exists.
- Deployment nodes and user-owned nodes never enter the node cleanup candidate/claim/destroy set
  merely because they hold zero workspaces.
- The 4h max-lifetime and 24h absolute ceilings remain as backstops.
- Tests are real-SQL/Miniflare where predicates matter and include discriminating controls.

## References

- `apps/api/src/scheduled/node-cleanup/shared.ts`
- `apps/api/src/scheduled/node-cleanup/node-phases.ts`
- `apps/api/src/scheduled/node-cleanup/index.ts`
- `apps/api/src/durable-objects/node-lifecycle.ts`
- `apps/api/src/services/session-sleep.ts`
- `apps/api/src/services/session-snapshot-upload-relay.ts`
- `apps/api/src/services/workspace-lifecycle-finalizer.ts`
- `apps/api/src/services/workspace-placement.ts`
- `tasks/active/2026-08-26-preserve-restorable-sleeping-sessions.md`
- `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`
- `tasks/archive/2026-08-17-fix-slept-session-classified-as-dead.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/51-server-side-node-class-gates.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
