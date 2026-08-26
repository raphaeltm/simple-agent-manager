# Shared agent-session closure finalizer for workspace/node deletion

## Problem

Production stability audit `production-stability-audit-2026-08-25.md` found 2,423
`agent_sessions.status='running'` rows attached to deleted workspaces. The root
cause is not a single bad cleanup branch: the NodeLifecycle DO closes
`agent_sessions` when it auto-deletes a stopped/sleeping workspace, while other
workspace/node deletion and terminal-teardown writers update only
`workspaces`/`nodes` or duplicate ad-hoc agent-session updates.

This creates stale D1 lifecycle mirrors and makes every new teardown writer a
silent regression risk.

Historical stale-row repair is explicitly out of scope for this task.

## Research findings

- Audit section "Stale mirrors and historical debris" confirms:
  - 2,423 `running` `agent_sessions` rows joined deleted workspaces.
  - NodeLifecycle closes `agent_sessions`; `scheduled/node-cleanup/workspace-phases.ts`
    and `services/nodes.ts` do not.
  - Recommended invariant: enumerate every workspace/node deletion writer and
    assert the same effective-state postcondition.
- Existing NodeLifecycle closure logic lives in
  `apps/api/src/durable-objects/node-lifecycle.ts` and directly updates
  `agent_sessions` after setting `workspaces.status='deleted'`.
- ProjectData `stopSession()` schedules D1 session-summary sync; deletion paths
  that only mutate D1 `agent_sessions` can leave chat/session summary mirrors
  stale until later repair.
- Writer inventory found so far:
  - NodeLifecycle DO stopped/sleeping workspace auto-delete:
    `apps/api/src/durable-objects/node-lifecycle.ts`
  - Node cleanup orphaned workspace stop and stale stopped workspace delete:
    `apps/api/src/scheduled/node-cleanup/workspace-phases.ts`
  - Node cleanup cf-container terminal task sweep:
    `apps/api/src/scheduled/node-cleanup/node-phases.ts` via `stopNodeResources`
  - Node cleanup node destroy helper:
    `apps/api/src/scheduled/node-cleanup/shared.ts` via `deleteNodeResourcesStrict`
    then node `status='deleted'`
  - `stopNodeResources`, `deleteNodeResources`,
    `retireDeletedDeploymentNodeRecord`: `apps/api/src/services/nodes.ts`
  - Explicit node stop/delete API: `apps/api/src/routes/nodes.ts`
  - Explicit workspace delete and task close cleanup:
    `apps/api/src/services/workspace-cleanup.ts`
  - Trial expiry cleanup: `apps/api/src/scheduled/trial-expire.ts`
  - Instant/cf-container runtime terminal persistence:
    `apps/api/src/durable-objects/vm-agent-container-runtime.ts`
  - Deployment environment/node deletion:
    `apps/api/src/routes/deployment-environment-lifecycle.ts`,
    `apps/api/src/routes/deployment-environments.ts` via `deleteNodeResources` /
    `retireDeletedDeploymentNodeRecord`
  - Capacity/provisioning race node-row deletes in `services/nodes.ts` and
    `services/deployment-provisioning.ts` are node records without workspaces yet;
    inventory test should allowlist these with explicit reasons.
  - Session-snapshot retention destroys expired cf-container runtime via
    `destroyVmAgentContainer` after `ProjectData.stopSession`; it does not mark
    workspace/node deleted and is not a workspace deletion writer.

## Implementation checklist

- [x] Add one shared idempotent workspace lifecycle closure finalizer in
      `apps/api/src/services/`.
- [x] Move the NodeLifecycle inline `agent_sessions` closure to the shared finalizer.
- [x] Route node cleanup workspace phases through the shared finalizer.
- [x] Route `stopNodeResources`, `deleteNodeResources`, and
      `retireDeletedDeploymentNodeRecord` through the shared finalizer.
- [x] Route explicit workspace deletion cleanup through the shared finalizer.
- [x] Route trial expiry cleanup through the shared finalizer.
- [x] Route cf-container terminal runtime persistence through the shared finalizer
      instead of duplicating `agent_sessions` closure.
- [x] Route TaskRunner DO failure cleanup and Instant launch failure cleanup through
      the shared finalizer.
- [x] Add/extend vertical-slice tests proving no related `agent_sessions` row
      remains `running` after the main deletion paths.
- [x] Add a machine-checked writer-inventory test modeled on
      `workspace-branch-guard-coverage.test.ts`; include a non-trivial minimum
      file count and allowlist reasons for non-workspace allocation deletes.
- [x] Verify the inventory test fails when an unguarded deletion writer is added,
      then restore it.
- [x] File a SAM Idea follow-up for historical stale-row repair only after the
      invariant exists: `01M0XTKC0HDZ2Q7MY098A0K67M`.
- [x] Include writer inventory and per-writer disposition in the PR description.

## Final writer inventory and disposition

| Writer / teardown path                                                                                                                                                           | Disposition                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NodeLifecycle DO stopped/sleeping workspace auto-delete (`durable-objects/node-lifecycle.ts`)                                                                                    | Calls `finalizeWorkspaceLifecycleClosure()` after D1 workspace tombstone.                                                                                                              |
| Node cleanup orphaned workspace stop (`scheduled/node-cleanup/workspace-phases.ts`)                                                                                              | Calls finalizer with `agentSessionStatus='stopped'`.                                                                                                                                   |
| Node cleanup stale stopped workspace delete (`scheduled/node-cleanup/workspace-phases.ts`)                                                                                       | Calls finalizer with `agentSessionStatus='completed'` after guarded status update changes a row.                                                                                       |
| Node cleanup cf-container terminal sweep (`scheduled/node-cleanup/node-phases.ts`)                                                                                               | Routes through `stopNodeResources()`, which finalizes.                                                                                                                                 |
| Node cleanup node destroy helper (`scheduled/node-cleanup/shared.ts`)                                                                                                            | Calls finalizer after node tombstone for any remaining attached workspaces.                                                                                                            |
| `stopNodeResources()` (`services/nodes.ts`)                                                                                                                                      | Calls finalizer for both managed and user-owned node branches.                                                                                                                         |
| `deleteNodeResources()` (`services/nodes.ts`)                                                                                                                                    | Calls finalizer after workspace tombstones.                                                                                                                                            |
| `retireDeletedDeploymentNodeRecord()` (`services/nodes.ts`)                                                                                                                      | Now receives `env` and calls finalizer after deployment workspace tombstones.                                                                                                          |
| Explicit node stop/delete routes (`routes/nodes.ts`)                                                                                                                             | Duplicate `agent_sessions` updates/deletes removed; routes delegate to service finalizer paths.                                                                                        |
| Deployment environment stop/delete routes (`routes/deployment-environment-lifecycle.ts`, `routes/deployment-environments.ts`)                                                    | Pass `env` into `retireDeletedDeploymentNodeRecord()` and otherwise delegate to `deleteNodeResources()`.                                                                               |
| Explicit workspace stop route (`routes/workspaces/lifecycle.ts`)                                                                                                                 | VM branch calls finalizer with `stopped`; cf-container branch delegates to `stopNodeResources()`.                                                                                      |
| Explicit workspace delete/task-close cleanup (`services/workspace-cleanup.ts`)                                                                                                   | Calls finalizer before hard-deleting workspace row; no direct `agent_sessions` delete remains.                                                                                         |
| Trial expiry cleanup (`scheduled/trial-expire.ts`)                                                                                                                               | Replaced duplicated `agent_sessions`/`compute_usage`/ProjectData cleanup with finalizer.                                                                                               |
| Instant/cf-container runtime terminal persistence (`durable-objects/vm-agent-container-runtime.ts`)                                                                              | Replaced direct `agent_sessions` update with finalizer.                                                                                                                                |
| Instant launch failure teardown (`services/instant-session.ts`)                                                                                                                  | Calls finalizer after workspace/node error tombstones and before container destroy.                                                                                                    |
| TaskRunner DO VM failure cleanup (`durable-objects/task-runner/state-machine.ts`)                                                                                                | Calls finalizer after workspace stop; removes duplicate compute-only cleanup path.                                                                                                     |
| Task cleanup service (`services/task-runner.ts`)                                                                                                                                 | Calls finalizer after workspace stop; cf-container branch delegates to `stopNodeResources()`.                                                                                          |
| Task/session terminal cleanup wrappers (`scheduled/stuck-tasks.ts`, `services/session-sleep.ts`, `services/task-terminal-cleanup.ts`, ProjectData dead-target/attention cleanup) | Delegate to `cleanupTaskRun()` where workspace/node teardown occurs.                                                                                                                   |
| Strict external node deletion (`services/strict-node-deletion.ts`)                                                                                                               | Allowlisted: external teardown only; callers own D1 row mutation and finalizer sequencing.                                                                                             |
| Fresh node allocation race deletes (`durable-objects/task-runner/node-steps.ts`, `services/deployment-provisioning.ts`, `services/nodes.ts`)                                     | Allowlisted or routed in containing service: node rows are deleted before any workspace/agent_session can reference them.                                                              |
| Session-snapshot D1 retention cf-container destroy (`scheduled/d1-retention.ts`)                                                                                                 | Allowlisted: stops ProjectData session and destroys expired runtime state without marking workspace/node rows deleted; container DO terminal persistence owns D1 runtime finalization. |
| VM_AGENT_CONTAINER transport wrapper (`services/vm-agent-container.ts`)                                                                                                          | Allowlisted: no D1 lifecycle mutation; container DO calls `persistRuntimeEnded()`.                                                                                                     |

## Verification

- `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/services/workspace-lifecycle-finalizer-coverage.test.ts tests/unit/scheduled/trial-expire.test.ts tests/unit/scheduled/trial-expire-missing-vm-vertical.test.ts tests/unit/services/workspace-cleanup.test.ts tests/unit/services/nodes-delete.test.ts`
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/node-lifecycle-do.test.ts tests/workers/scheduled-node-cleanup.test.ts tests/workers/workspace-lifecycle-finalizer-vertical.test.ts`
- Red-check: temporarily added an unguarded source writer under `apps/api/src/services`; the inventory test failed on it, then passed after removing the fixture.
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm exec prettier --check ...` for all touched files

## Acceptance criteria

- [ ] All workspace/node deletion or terminal-teardown writers either call the
      shared finalizer or are allowlisted in the inventory test with a written
      reason.
- [ ] NodeLifecycle, scheduled cleanup, node service/API cleanup, trial expiry,
      workspace deletion, and cf-container teardown paths leave no related
      `agent_sessions.status='running'`.
- [ ] ProjectData session-summary sync is preserved by stopping/failing related
      chat sessions through ProjectData where workspace metadata has a
      `project_id` and `chat_session_id`.
- [ ] Existing historical stale `agent_sessions` rows are not repaired in this PR.
- [ ] Focused tests, quality suite, staging verification, PR CI, merge, and
      production deploy monitoring complete successfully.

## References

- `.library/reliability/audits/production-stability-audit-2026-08-25.md/production-stability-audit-2026-08-25.md`
- `.claude/rules/24-no-duplicate-ui-controls.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/59-understand-before-adding.md`
- `.claude/rules/61-guards-must-cover-every-runtime.md`
- `apps/api/src/durable-objects/node-lifecycle.ts`
- `apps/api/src/scheduled/node-cleanup/workspace-phases.ts`
- `apps/api/src/services/nodes.ts`
- `apps/api/tests/unit/services/workspace-branch-guard-coverage.test.ts`
