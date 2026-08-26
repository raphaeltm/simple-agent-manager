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

- [ ] Add one shared idempotent workspace lifecycle closure finalizer in
      `apps/api/src/services/`.
- [ ] Move the NodeLifecycle inline `agent_sessions` closure to the shared finalizer.
- [ ] Route node cleanup workspace phases through the shared finalizer.
- [ ] Route `stopNodeResources`, `deleteNodeResources`, and
      `retireDeletedDeploymentNodeRecord` through the shared finalizer.
- [ ] Route explicit workspace deletion cleanup through the shared finalizer.
- [ ] Route trial expiry cleanup through the shared finalizer.
- [ ] Route cf-container terminal runtime persistence through the shared finalizer
      instead of duplicating `agent_sessions` closure.
- [ ] Add/extend vertical-slice tests proving no related `agent_sessions` row
      remains `running` after the main deletion paths.
- [ ] Add a machine-checked writer-inventory test modeled on
      `workspace-branch-guard-coverage.test.ts`; include a non-trivial minimum
      file count and allowlist reasons for non-workspace allocation deletes.
- [ ] Verify the inventory test fails when an unguarded deletion writer is added,
      then restore it.
- [ ] File a SAM Idea follow-up for historical stale-row repair only after the
      invariant exists.
- [ ] Include writer inventory and per-writer disposition in the PR description.

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
