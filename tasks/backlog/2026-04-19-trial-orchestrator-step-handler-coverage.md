# Trial orchestrator — broaden step handler unit tests

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** some handler tests. Test paths are under `apps/api/tests/unit/`.
>   - `handleNodeSelection`: `durable-objects/trial-orchestrator-steps.test.ts:311` and
>     `services/relay-trial-native-selection.test.ts:96-133`.
>   - `handleNodeProvisioning`, fresh path only: `trial-orchestrator-steps.test.ts:398,448`.
>   - `handleNodeAgentReady`: `trial-orchestrator-steps.test.ts:564,577`.
>   - `handleWorkspaceCreation`, admission cleanup only: `trial-orchestrator-steps.test.ts:508`.
>   - `handleProjectCreation`, happy path and branch re-entry:
>     `durable-objects/trial-orchestrator-agent-boot.test.ts:333-422`.
> - **Still open:** source is `apps/api/src/durable-objects/trial-orchestrator/steps.ts`.
>   - `handleWorkspaceReady` (`steps.ts:777`) has no tests at all.
>   - `handleProjectCreation`: re-entry with `projectId` set; permanent error on the FK violation.
>   - `handleNodeProvisioning`: re-entry with `state.nodeId` set (`steps.ts:510-528`).
>   - `handleNodeAgentReady`: permanent error on node failure.
>   - `handleWorkspaceCreation`: name-collision retry; permanent error on rejection.
>   - `handleNodeSelection`: permanent error when there are zero providers.
>   - `syncTrialRecord` (`steps.ts:174`): a KV write failure is non-fatal.

## Problem
`apps/api/src/durable-objects/trial-orchestrator/steps.ts` exports 8 step
handlers. After the wire-up PR, only `handleRunning` and
`handleDiscoveryAgentStart` have direct unit tests
(`tests/unit/durable-objects/trial-orchestrator-steps.test.ts`).

The remaining 6 handlers rely on drizzle + node-agent + project-data services
and need richer mocks to cover their idempotency + error-classification
branches.

## Context
- Original wire-up PR: <link when merged>
- Test-engineer review finding #2 (HIGH) was partially addressed in the
  wire-up PR; full coverage deferred to this task.
- The `TrialOrchestratorContext` interface
  (`durable-objects/trial-orchestrator/types.ts`) is designed to make these
  handlers testable as plain functions — the scope here is writing mocks, not
  re-architecting.

## Handlers to cover
- `handleProjectCreation` — idempotency guard when `state.projectId` is set
  and the row already exists in D1; permanent-error classification on FK
  violation against the sentinel installation row.
- `handleNodeSelection` — healthy existing node branch; no healthy node
  branch; permanent-error on zero providers.
- `handleNodeProvisioning` — idempotency: `state.nodeId` set with status
  `running` advances without recreating.
- `handleNodeAgentReady` — time-boxed polling; permanent-error on node
  failure.
- `handleWorkspaceCreation` — name collision retry; permanent-error on
  workspace service rejection.
- `handleWorkspaceReady` — workspace status `error` throws permanent.

## Acceptance Criteria
- [ ] Each handler has at least one test for its happy path
- [ ] Each handler has at least one test for its idempotency re-entry branch
- [ ] Each handler has at least one test for the permanent-error path
- [ ] `syncTrialRecord` KV write failure is non-fatal (tested)
