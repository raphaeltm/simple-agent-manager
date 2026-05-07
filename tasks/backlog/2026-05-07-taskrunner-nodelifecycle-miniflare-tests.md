# TaskRunner & NodeLifecycle Miniflare Integration Tests

**Created**: 2026-05-07
**Source**: Evaluation P2-02 (testing foundation)

## Problem Statement

The two most critical Durable Objects — TaskRunner (orchestrates task execution) and NodeLifecycle (manages warm pool state machine) — have zero Miniflare integration tests. They are tested only with `vi.mock()` unit tests that cannot exercise real D1 transactions, DO alarm scheduling, or multi-step state transitions.

## Research Findings

### TaskRunner DO (`apps/api/src/durable-objects/task-runner/index.ts`)
- Alarm-driven state machine: `node_selection → node_provisioning → node_agent_ready → workspace_creation → workspace_ready → attachment_transfer → agent_session → running`
- Each step handler makes D1 queries and external HTTP calls (node agent, Hetzner)
- `start()` persists initial state + schedules first alarm at `Date.now()`
- `alarm()` dispatches to step handlers; retries transient errors with backoff
- `failTask()` updates D1 tasks table, inserts status event, writes to OBSERVABILITY_DATABASE
- External calls (Hetzner API, VM agent) cannot be mocked in Miniflare — must stub at fetch level or test state transitions only

### NodeLifecycle DO (`apps/api/src/durable-objects/node-lifecycle.ts`)
- Simple state machine: `active → warm → destroying`
- `markIdle(nodeId, userId)` → sets warm + schedules alarm at `now + warmTimeout`
- `markActive()` → cancels alarm, clears warm_since
- `tryClaim(taskId)` → on warm: claims → active; on active/destroying: returns false
- `alarm()` → on warm (expired): transitions to `destroying`, updates D1 `nodes` table
- Also handles workspace auto-deletion scheduling
- Only needs D1 `nodes` table + DO storage — simpler to test than TaskRunner

### Existing Miniflare Test Pattern (`apps/api/tests/workers/`)
- Uses `@cloudflare/vitest-pool-workers` via `vitest.workers.config.ts`
- Config: `cloudflareTest({ main: './src/index.ts', miniflare: { ... } })`
- Tests import `env` from `cloudflare:test` and get DO stubs via `env.DO_NAME.idFromName()`
- DO methods called directly on stubs (RPC style since compat date 2024-04-03)
- D1 bindings available as `env.DATABASE`
- 11 existing test files in `tests/workers/`

### Key Constraints
- TaskRunner step handlers make external HTTP fetch calls (Hetzner API, VM agent). These will fail in Miniflare. Tests must focus on: initial state persistence, alarm scheduling, state transitions that DON'T require external calls, and failure handling.
- NodeLifecycle is self-contained (D1 + DO storage) — can be tested more thoroughly.
- The `OBSERVABILITY_DATABASE` D1 binding must be added to the Miniflare config.
- The `TASK_RUNNER` and `NODE_LIFECYCLE` DO bindings must be added to `vitest.workers.config.ts`.

## Implementation Checklist

- [ ] Add `TASK_RUNNER` and `NODE_LIFECYCLE` DO bindings to `vitest.workers.config.ts`
- [ ] Add `OBSERVABILITY_DATABASE` D1 binding to `vitest.workers.config.ts`
- [ ] Create `tests/workers/node-lifecycle-do.test.ts`:
  - [ ] markIdle → warm state, D1 warm_since updated
  - [ ] markActive → active state, D1 warm_since cleared
  - [ ] tryClaim on warm → claimed, transitions to active
  - [ ] tryClaim on active → not claimed
  - [ ] alarm fires after warm timeout → transitions to destroying, D1 updated
  - [ ] markIdle on destroying → throws conflict error
  - [ ] Workspace deletion scheduling and processing
- [ ] Create `tests/workers/task-runner-do.test.ts`:
  - [ ] start() persists initial state with correct shape
  - [ ] start() is idempotent (second call is no-op)
  - [ ] getStatus() returns current state (with redacted mcpToken)
  - [ ] advanceWorkspaceReady stores signal in state
  - [ ] alarm on node_selection step attempts to select node (will error due to no D1 data — tests error/retry path)
  - [ ] failTask updates D1 task status to 'failed', inserts status event
- [ ] Seed D1 tables with minimal required data in test setup (users, projects, tasks, nodes)
- [ ] Verify all tests pass: `pnpm --filter @simple-agent-manager/api test:workers`
- [ ] Verify typecheck passes: `pnpm typecheck`

## Acceptance Criteria

- [ ] `node-lifecycle-do.test.ts` exercises warm/destroy lifecycle with real D1 + DO bindings
- [ ] `task-runner-do.test.ts` exercises start/idempotency, getStatus, advanceWorkspaceReady, and failTask with real D1 + DO bindings
- [ ] Both test files use Miniflare bindings (no vi.mock)
- [ ] Tests pass in CI (`pnpm --filter @simple-agent-manager/api test:workers`)
- [ ] No new lint or typecheck errors

## References

- `apps/api/src/durable-objects/task-runner/index.ts` — TaskRunner DO
- `apps/api/src/durable-objects/node-lifecycle.ts` — NodeLifecycle DO
- `apps/api/vitest.workers.config.ts` — Miniflare test config
- `apps/api/tests/workers/mission-state-do.test.ts` — Reference test pattern
- `docs/evaluations/2026-05-07-codebase-data-model-agent-readiness/tracks/06-testing-experiments.md`
