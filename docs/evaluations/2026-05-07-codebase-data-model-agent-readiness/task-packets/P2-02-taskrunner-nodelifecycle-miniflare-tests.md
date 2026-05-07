# P2-02: TaskRunner & NodeLifecycle Miniflare Integration Tests

**Phase**: 2 (Testing Foundation)
**Priority**: P1
**Risk Level**: Low-Medium — adds tests, no behavior changes
**Effort**: L (2-3 days)
**Source Findings**: F-021 (Track 6: Testing)
**Recommended Skill(s)**: `$cloudflare-specialist`, `$test-engineer`

## Scope

The two most critical Durable Objects — TaskRunner (orchestrates task execution) and NodeLifecycle (manages warm pool state machine) — have zero Miniflare integration tests. They are tested only with `vi.mock()` unit tests that cannot exercise real D1 transactions, DO alarm scheduling, or multi-step state transitions.

## Files Likely Touched

- `apps/api/tests/workers/task-runner-do.test.ts` (new)
- `apps/api/tests/workers/node-lifecycle-do.test.ts` (new)
- `apps/api/vitest.workers.config.ts` — may need new bindings/config for these DOs

## Compatibility Constraints

- Tests must use realistic D1/KV/DO bindings via Miniflare, not source-contract assertions
- Must not modify the DOs themselves — tests observe existing behavior
- Follow existing Miniflare test patterns from `apps/api/tests/workers/` (e.g., `project-data-do.test.ts`)

## Automated Tests to Add/Run

- `apps/api/tests/workers/task-runner-do.test.ts`:
  - Task created → alarm fires → state transitions through pending → provisioning → workspace_ready → agent_session → completed
  - Key failure path: node provisioning fails → task transitions to failed state
- `apps/api/tests/workers/node-lifecycle-do.test.ts`:
  - Node marked idle → alarm fires → state transitions to warm
  - Warm timeout expires → alarm fires → transitions to destroying
  - Warm node reused → alarm cancelled, state returns to active
- Run: `pnpm --filter @simple-agent-manager/api test:workers`

## Manual Staging Verification

- N/A — test infrastructure only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- TaskRunner and NodeLifecycle state machines have integration test coverage
- Alarm scheduling behavior verified with real Miniflare DO bindings

## Visible Behavior Changes

- None to end users
- CI runs additional integration tests

## Rollback Notes

- Delete the test files. No state to clean up.

## Acceptance Criteria

- [ ] `task-runner-do.test.ts`: Happy path through full task lifecycle with real D1/DO bindings
- [ ] `task-runner-do.test.ts`: At least one failure path (e.g., provisioning failure)
- [ ] `node-lifecycle-do.test.ts`: Warm pool state machine with alarm-driven transitions
- [ ] Both tests use real Miniflare D1/DO bindings, not mocks
- [ ] Tests pass in CI (`pnpm --filter api test:workers`)

## Links

- Track report: `tracks/06-testing-experiments.md` (Section: TaskRunner and NodeLifecycle)
- Finding: F-021 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 3, Task 3B
- Pattern reference: existing tests in `apps/api/tests/workers/`
