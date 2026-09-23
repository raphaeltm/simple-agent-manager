# Compute pools Wave 0 invariant tests

## Problem

Wave 0 of compute/node-pools needs regression coverage around today's scheduler and placement behavior before later refactors centralize pool resolution. This PR must preserve current behavior and add tests/scaffolding only.

## Research findings

- `apps/api/src/durable-objects/task-runner/node-selection.ts` has the TaskRunner D1 selector (`findNodeWithCapacity`) used during VM task placement.
- `apps/api/src/services/node-selector.ts` has a separate Drizzle selector (`selectNodeForTaskRun`) with similar same-user, capacity, health, size, and location logic.
- `apps/api/src/services/workspace-placement.ts` reserves the final workspace slot with a single `INSERT ... SELECT` statement gated by node id, node user, running status, workspace role, and active workspace count.
- `apps/api/tests/workers/vm-admission-control-races.test.ts` already exercises real D1 state for VM admission and existing-node packing, making it the best place for cross-project/user placement invariants.
- `apps/api/tests/integration/node-selection.test.ts` already documents duplicated selector logic with source-contract assertions. Wave 0 should not refactor that duplication.
- Task submission entry points duplicate VM/provider/location/reservation resolution across `routes/tasks/submit.ts`, `routes/mcp/dispatch-tool.ts`, `durable-objects/sam-session/tools/dispatch-task.ts`, and `services/trigger-submit.ts`; Wave 0 may document that with a small source assertion but must not change behavior.

## Implementation checklist

- [x] Extend D1-backed placement tests to prove same-user work from multiple projects can reuse/pack onto the same user-owned workspace node when no project pool exists.
- [x] Extend D1-backed placement tests to prove different users do not share workspace nodes.
- [x] Add final reservation tests proving `reserveWorkspacePlacement` atomically vetoes changed node status, changed node owner, non-workspace node role, and full status-capacity.
- [x] Add a lightweight source-contract/TODO assertion documenting duplicated placement-resolution entry points without refactoring them.
- [x] Run targeted API tests locally.
- [x] Run CI-oriented local validation without staging.
- [x] Open a child PR against `sam/compute-pools-integration`.

## Validation notes

- `pnpm --filter @simple-agent-manager/api test -- tests/integration/node-selection.test.ts` — passed, 1 file / 29 tests.
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/vm-admission-control-races.test.ts --reporter=verbose` — passed, 1 file / 10 tests.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm format:check` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm --filter @simple-agent-manager/api test` — passed, 618 files / 8445 tests.
- `pnpm quality:source-contract-tests` — passed.

## Review notes

- `test-engineer` WARN findings were addressed by isolating the same-user cross-project fixture under its own user/projects, avoiding `node_class='user-owned'` as a stand-in for pool scope, and allowing placement fixtures to carry realistic project repository/installation metadata.
- `cloudflare-specialist` PASS: D1/Miniflare coverage exercises the atomic `INSERT ... SELECT` reservation shape and real D1 state.
- Known non-blocking Wave 0 gap: `selectNodeForTaskRun` already has same-user behavioral coverage in `apps/api/tests/unit/services/node-selector-user-scope.test.ts`, but this PR does not add new project-aware tests for that Drizzle selector because it has no project discriminator today. The source-contract test documents the duplicate entry points until the shared resolver exists.

## PR

- Draft child PR: https://github.com/raphaeltm/simple-agent-manager/pull/1944
- Base: `sam/compute-pools-integration`
- Head: `sam/execute-task-using-skill-a04wvw`

## Acceptance criteria

- Behavior-preserving test/scaffolding PR is opened against `sam/compute-pools-integration`.
- No staging deployment or staging mutation is performed.
- Local validation commands and results are reported.
- Any blocker or test gap is documented in the PR and final summary.
