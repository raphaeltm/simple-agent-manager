# TDF-5: Workspace Lifecycle — Event-Driven Readiness (SPEC)

**Created**: 2026-02-27
**Priority**: High (P1 — eliminates the biggest waitUntil death window)
**Classification**: `cross-component-change`, `business-logic-change`
**Dependencies**: TDF-2 (Orchestration Engine), TDF-4 (VM Agent Contract)
**Blocked by**: TDF-2, TDF-4
**Blocks**: TDF-8 (Frontend State Tracking)

---

## THIS TASK REQUIRES A FULL SPECIFICATION WORKFLOW

This redesigns how workspace readiness is detected — from polling to event-driven. It **must** go through the complete speckit flow:

1. **`/speckit.specify`** — Create the feature specification from the context below
2. **`/speckit.plan`** — Generate the implementation plan
3. **`/speckit.tasks`** — Generate actionable implementation tasks
4. **`/speckit.implement`** — Execute the implementation

### Agent Instructions

- **Read all research references below before starting.** The flow map contains the complete workspace readiness chain with sequence diagrams.
- **TDF-2 (Orchestration Engine) and TDF-4 (VM Agent Contract) must be completed first.** This spec builds on the Durable Object orchestration model and the formalized VM agent API contract.
- **If at any point there are ambiguities or design decisions that require human input, STOP and ask for clarification.** The human can run `/speckit.clarify` to help resolve open questions.
- **Otherwise, proceed through the full workflow autonomously.**
- Key decisions that may need human input:
  - Whether the `/ready` callback directly creates the agent session or just advances the DO
  - How to handle the race: callback arrives before the DO has reached the workspace_ready step
  - Whether to keep D1 polling as a fallback or eliminate it entirely
  - Workspace error/timeout handling when the callback never arrives

---

## Context: Why This Exists

The workspace readiness check is the **longest single wait** in the orchestration pipeline and the **most common point of `waitUntil` death**. Currently:

1. Control plane POSTs to VM agent to create workspace (returns 202)
2. VM agent provisions workspace asynchronously (clone repo, build devcontainer, configure env)
3. On success, VM agent calls `markWorkspaceReady()` → HTTP POST to `/api/workspaces/{id}/ready`
4. Control plane updates workspace status in D1 to `running`
5. **Meanwhile**, the task runner polls D1 every 0.5-5s for up to 10 minutes waiting for status change
6. If the Worker is recycled during this polling loop, nobody advances the task

This is the P1 fix from our recommended fixes: **instead of polling, the `/ready` callback should directly advance the task pipeline**.

### Research References (READ THESE FIRST)

- **Complete flow map**: `docs/task-delegation-flow-map.md`
  - Section "Phase 3: VM Execution" — what happens on the VM during provisioning
  - Section "Known Weak Points" #5 — "Workspace Ready Callback Race"
  - Section "Known Weak Points" #1 — waitUntil death during polling
  - Section "Recommended Fixes" P1 — webhook-driven workspace readiness
- **Deep analysis**: `docs/notes/task-delegation-system-analysis.md`
  - Section "How Workspace Readiness Works" — full sequence diagram
  - Section "What startWorkspaceProvision Does on the VM" — the provisioning flow
  - Section "Quick Win: Workspace Ready Webhook" — the proposed solution
- **VM bootstrap**: `packages/vm-agent/internal/bootstrap/bootstrap.go` — `markWorkspaceReady()` implementation
- **VM workspace management**: `packages/vm-agent/internal/server/workspaces.go` — provisioning goroutine
- **Control plane workspace routes**: `apps/api/src/routes/workspaces.ts` — `/ready` and `/provisioning-failed` handlers
- **Current polling**: `apps/api/src/services/task-runner.ts` — `waitForWorkspaceReady()` function
- **Provisioning timeout**: `apps/api/src/services/timeout.ts` — cron-based timeout for stuck workspaces

---

## Problem Statement (Detailed)

### Current Readiness Chain (Broken)

```
Control Plane                           VM Agent
     |                                      |
     |-- POST /workspaces (202) ----------->|
     |                                      |-- goroutine: provision workspace
     |                                      |   |-- clone repo
     |-- poll D1 every 0.5-5s              |   |-- build devcontainer
     |   (backoff, 10 min timeout)         |   |-- setup git
     |   *** Worker can die here ***       |   |-- configure env
     |                                      |   |
     |<---- POST /workspaces/{id}/ready ----|   (single attempt, no retry)
     |-- UPDATE D1: status=running          |
     |                                      |
     |-- poll detects running               |
     |-- proceed to agent_session           |
```

**Failure modes:**
1. Worker dies during poll → task stuck in `delegated` until cron catches it (5+ min)
2. `/ready` callback fails (network, DNS, timeout) → workspace running on VM but `creating` in D1 → poll times out → task fails even though workspace is fine
3. Callback arrives but Worker that's polling is a different instance → callback updates D1, but original Worker may have already timed out

### Target Readiness Chain (Event-Driven)

```
Control Plane                           VM Agent
     |                                      |
     |-- POST /workspaces (202) ----------->|
     |                                      |-- goroutine: provision workspace
     |-- TaskRunner DO sets alarm           |   |-- clone repo
     |   (workspace_ready timeout)         |   |-- build devcontainer
     |                                      |   |-- setup git
     |                                      |   |-- configure env
     |                                      |   |
     |<---- POST /workspaces/{id}/ready ----|   (with retry, per TDF-4)
     |-- UPDATE D1: status=running          |
     |-- Wake TaskRunner DO (advance step)  |   <-- NEW: callback drives orchestration
     |-- DO creates agent session           |
     |-- DO marks task in_progress          |
     |                                      |
     |   (no polling loop, no waitUntil)   |
```

### Concurrency Concerns

The event-driven model introduces new concurrency questions:

1. **Callback arrives before DO reaches workspace_ready step**: The callback updates D1 to `running`, wakes the DO. If the DO is still on an earlier step (e.g., `workspace_creation`), it needs to either queue the advancement or handle it when it naturally reaches `workspace_ready`.

2. **Callback arrives after DO has timed out**: The DO may have already failed the task due to provisioning timeout. The callback should be a no-op (idempotent).

3. **Duplicate callbacks**: The VM agent retries the callback (per TDF-4). The handler must be idempotent.

4. **Provisioning failure after partial success**: The VM agent sends `provisioning-failed` after some components were set up. Cleanup must handle partial state.

---

## What the Spec Must Address

1. **Callback → DO integration**: How does the `/ready` endpoint find and wake the right TaskRunner DO? By workspace ID → task ID → DO?
2. **Step advancement**: Does the callback directly create the agent session, or does it just signal the DO to proceed to the next alarm?
3. **Race handling**: If the callback arrives before the DO expects it, what happens? Queue it? Skip the polling step?
4. **Timeout handling**: If the callback never arrives, the DO's timeout alarm fires. How does it determine if provisioning failed vs. is still in progress?
5. **Provisioning failure**: The `provisioning-failed` callback needs to advance the DO to an error state and trigger cleanup.
6. **D1 consistency**: Workspace status in D1 must stay consistent with what the DO knows. Who is the source of truth?
7. **Retry semantics**: With TDF-4's callback retries, the handler must be idempotent. How?
8. **Testing**: How to test the callback→DO→advancement flow with Miniflare?

---

## Testing Requirements (High-Level — Details in Spec)

### Unit Tests
- Workspace status transition validation (creating → running, creating → error)
- Callback payload parsing and JWT validation
- Idempotent callback handling (duplicate calls are no-ops)

### Integration Tests (Miniflare)
- Callback arrives → D1 updated → DO woken → task advances to agent_session
- Callback arrives before DO reaches workspace_ready → handled gracefully
- Callback arrives after DO timeout → no-op
- Provisioning-failed callback → DO transitions to error → cleanup triggered
- Duplicate callback → only processed once

### End-to-End Tests
- Full workspace lifecycle: creation → provisioning (mocked VM) → ready callback → agent session → running
- Provisioning timeout → error state → cleanup
- Provisioning failure → error callback → cleanup
- Workspace already exists (reuse) → skip provisioning

### Go-Side Tests (VM Agent)
- `markWorkspaceReady()` retry behavior (per TDF-4 contract)
- `notifyProvisioningFailed()` retry behavior
- Provisioning goroutine error handling → correct callback sent

---

## Key Files

| File | Action |
|------|--------|
| `apps/api/src/routes/workspaces.ts` | `/ready` handler wakes TaskRunner DO |
| `apps/api/src/durable-objects/` | TaskRunner DO workspace_ready step (from TDF-2) |
| `apps/api/src/services/task-runner.ts` | Remove `waitForWorkspaceReady()` polling |
| `apps/api/src/services/timeout.ts` | Simplify — DO handles its own timeouts |
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | Retry on `markWorkspaceReady()` (per TDF-4) |
| `packages/vm-agent/internal/server/workspaces.go` | Retry on `notifyProvisioningFailed()` (per TDF-4) |
| `apps/api/tests/integration/workspace-lifecycle.test.ts` | Comprehensive integration tests |

---

## Success Criteria

When this is complete:
- No polling loop for workspace readiness exists in the codebase
- The `/ready` callback directly advances the task pipeline via the TaskRunner DO
- Provisioning failures are reported immediately, not after a timeout
- Concurrent callbacks (retries, races) are handled idempotently
- Workspace lifecycle has full test coverage including all failure modes
- The provisioning timeout cron becomes a safety net, not the primary detection mechanism
