# Split task-runner.ts into smaller modules

## Problem

`apps/api/src/durable-objects/task-runner.ts` is 1,645 lines, exceeding the mandatory 800-line split threshold in `.claude/rules/18-file-size-limits.md`. Per rule 18's DO guidance: "Extract method groups into internal modules, DO delegates."

## Research Findings

- The file contains the `TaskRunner` Durable Object class with types, step handlers, state machine helpers, node selection helpers, D1 helpers, state access, and configuration getters.
- Existing pattern: `project-data/` directory uses module files with exported functions; DO class delegates to them via `import * as moduleName`.
- For TaskRunner, methods are private instance methods accessing `this.env`, `this.ctx.storage`. Extract as standalone functions receiving a context object (env, ctx, state).
- External imports of `TaskRunner`:
  - `apps/api/src/index.ts`: `export { TaskRunner } from './durable-objects/task-runner'`
  - `apps/api/src/services/task-runner-do.ts`: `import type { StartTaskInput, TaskRunner }`
  - `apps/api/src/scheduled/stuck-tasks.ts`: `import type { TaskRunner }`
  - Various tests reference the old path via source-contract tests
- `task-runner-helpers.ts` already exists as a sibling — it stays where it is (or moves into the directory).
- The test at `task-runner-do-infra.test.ts:73` asserts the exact export path: `"export { TaskRunner } from './durable-objects/task-runner'"` — after the split, the barrel `index.ts` at `./durable-objects/task-runner/index.ts` will resolve to the same import path `./durable-objects/task-runner`, so this test continues to pass.

## Implementation Checklist

- [ ] 1. Create `apps/api/src/durable-objects/task-runner/` directory
- [ ] 2. Create `task-runner/types.ts` — move `StepResults`, `TaskRunConfig`, `TaskRunnerState`, `StartTaskInput` interfaces
- [ ] 3. Create `task-runner/node-steps.ts` — extract `handleNodeSelection`, `handleNodeProvisioning`, `handleNodeAgentReady`, `verifyNodeAgentHealthy`, `tryClaimWarmNode`, `findNodeWithCapacity`
- [ ] 4. Create `task-runner/workspace-steps.ts` — extract `handleWorkspaceCreation`, `handleWorkspaceReady`, `handleAttachmentTransfer`
- [ ] 5. Create `task-runner/agent-session-step.ts` — extract `handleAgentSession`
- [ ] 6. Create `task-runner/state-machine.ts` — extract `ensureSessionLinked`, `advanceToStep`, `transitionToInProgress`, `failTask`, `cleanupOnFailure`, `updateD1ExecutionStep`
- [ ] 7. Create `task-runner/index.ts` — DO class (`TaskRunner`) with `start`, `advanceWorkspaceReady`, `getStatus`, `alarm`, `getState`, config getters; delegates to extracted modules; re-exports types
- [ ] 8. Move `task-runner-helpers.ts` into the directory as `task-runner/helpers.ts` and update all imports
- [ ] 9. Delete the old `apps/api/src/durable-objects/task-runner.ts`
- [ ] 10. Verify barrel re-export preserves all external import paths
- [ ] 11. Run `pnpm typecheck` — fix any type errors
- [ ] 12. Run `pnpm lint` — fix any lint issues
- [ ] 13. Run `pnpm test` — all tests pass without modification
- [ ] 14. Run `pnpm build` — build succeeds
- [ ] 15. Verify no file exceeds 500 lines: `wc -l` on all new files

## Acceptance Criteria

- [ ] No file in `task-runner/` exceeds 500 lines
- [ ] All existing imports of `TaskRunner`, `StartTaskInput`, `TaskRunnerState` resolve without changes to consumers
- [ ] All tests pass without modification
- [ ] Build succeeds
- [ ] Zero behavioral changes — pure refactor

## References

- `.claude/rules/18-file-size-limits.md`
- `apps/api/src/durable-objects/project-data/` (reference pattern)
