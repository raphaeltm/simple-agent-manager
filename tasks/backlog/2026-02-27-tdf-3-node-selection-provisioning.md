# TDF-3: Node Selection & Provisioning — Isolated Subsystem Hardening

**Created**: 2026-02-27
**Priority**: Medium
**Classification**: `business-logic-change`, `cross-component-change`
**Dependencies**: None (independent subsystem)
**Blocked by**: Nothing
**Blocks**: Nothing directly (TDF-2 orchestration engine will call into this)

---

## Context

Node selection is the first decision point in task execution: given a user's running nodes, warm pool, and capacity constraints, pick the best node (or provision a new one). This is a self-contained decision with clear inputs (D1 state, node health) and outputs (a node ID or null + provisioning).

Our research identified this as an independent subsystem that can be hardened and tested in isolation.

### Research References

- **Flow map**: `docs/task-delegation-flow-map.md` — "Phase 2: Async Orchestration", Step 1 (Node Selection)
- **Current implementation**: `apps/api/src/services/node-selector.ts`
- **Node lifecycle DO**: `apps/api/src/durable-objects/node-lifecycle.ts`
- **Configuration**: Flow map section "Configuration Reference" — Node Selection variables

---

## Problem Statement

Node selection currently works but has gaps in test coverage and edge case handling:

1. **Warm pool claiming race conditions** — Multiple concurrent tasks could try to claim the same warm node. The DO `tryClaim()` handles this, but the overall flow (D1 query → DO claim → fallback) needs integration testing
2. **Capacity scoring algorithm untested** — The 40% CPU + 60% memory scoring has no tests proving it selects the right node
3. **Provisioning failure recovery** — If Hetzner provisioning fails mid-way, cleanup is best-effort
4. **Health polling reliability** — The 120s/5s health check loop has no tests for timeout and retry behavior
5. **Node limit enforcement** — `maxNodesPerUser` is checked but concurrent provisioning could exceed limits

---

## Scope

### In Scope

- Comprehensive unit tests for node selection logic (warm pool, capacity, scoring)
- Integration tests for warm pool claiming with concurrent access
- Unit tests for provisioning flow (Hetzner API calls, health polling)
- Edge case tests (no nodes available, all nodes full, size mismatch, location mismatch)
- Node limit enforcement under concurrent provisioning
- Health polling timeout and retry behavior tests

### Out of Scope

- Changing the selection algorithm (unless tests reveal bugs)
- The orchestration engine that calls node selection (TDF-2)
- NodeLifecycle DO internals (warm timeout, destruction) — covered by TDF-7

---

## Acceptance Criteria

- [ ] Unit tests for every branch in `selectNodeForTaskRun()` — warm pool hit, capacity match, no match
- [ ] Unit tests for the capacity scoring algorithm with various CPU/memory combinations
- [ ] Integration test: two concurrent tasks try to claim the same warm node, only one succeeds
- [ ] Unit tests for provisioning flow: success path, Hetzner API failure, health check timeout
- [ ] Unit tests for health polling: success on first try, success after retries, timeout after 120s
- [ ] Unit tests for node limit enforcement: at limit, over limit, concurrent provisioning
- [ ] Edge case tests: zero nodes, all nodes at capacity, size/location mismatch fallback
- [ ] All tests pass in CI

---

## Testing Requirements

### Unit Tests

| Test Category | What to Test |
|--------------|-------------|
| Warm pool selection | Nodes sorted by size/location match, best match selected first |
| Warm pool miss | No warm nodes → falls through to capacity check |
| Capacity selection | Running nodes filtered by health/workspace count/CPU/memory thresholds |
| Capacity scoring | 40% CPU + 60% memory scoring selects lowest-load node |
| No available node | Returns null, triggers provisioning path |
| Provisioning success | Creates D1 record, calls Hetzner, waits for health |
| Provisioning failure | Hetzner API error, node record cleaned up |
| Health polling | Success, retry, timeout behaviors |
| Node limit | At limit rejects, under limit allows |

### Integration Tests (Miniflare)

| Test Category | What to Test |
|--------------|-------------|
| Warm pool race | Two concurrent tryClaim() calls, one wins |
| D1 freshness recheck | Node state changes between query and claim |
| Concurrent provisioning | Two tasks provision simultaneously, node limit respected |

---

## Key Files

| File | Action |
|------|--------|
| `apps/api/src/services/node-selector.ts` | Add tests, fix any bugs found |
| `apps/api/src/durable-objects/node-lifecycle.ts` | Test tryClaim() concurrency |
| `apps/api/src/services/node-agent.ts` | Test health polling |
| `apps/api/tests/unit/node-selector.test.ts` | Create comprehensive unit tests |
| `apps/api/tests/integration/node-selection.test.ts` | Create integration tests |
