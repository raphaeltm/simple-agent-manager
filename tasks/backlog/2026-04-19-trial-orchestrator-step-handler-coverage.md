# Trial orchestrator — broaden step handler unit tests

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
