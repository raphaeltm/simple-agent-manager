# TDF-2: Orchestration Engine — Durable Object Migration (SPEC)

**Created**: 2026-02-27
**Priority**: Critical (P0 — everything depends on this)
**Classification**: `cross-component-change`, `business-logic-change`, `infra-change`
**Dependencies**: TDF-1 (Task State Machine must be hardened first)
**Blocked by**: TDF-1
**Blocks**: TDF-5 (Workspace Lifecycle), TDF-6 (Chat Session Management), TDF-7 (Recovery & Resilience)

---

## THIS TASK REQUIRES A FULL SPECIFICATION WORKFLOW

This is an architectural migration that redesigns the core execution model. It **must** go through the complete speckit flow:

1. **`/speckit.specify`** — Create the feature specification from the context below
2. **`/speckit.plan`** — Generate the implementation plan with data models, API changes, migration strategy
3. **`/speckit.tasks`** — Generate actionable, dependency-ordered implementation tasks
4. **`/speckit.implement`** — Execute the implementation

### Agent Instructions

- **Read all research references below before starting.** The flow map and analysis documents contain the complete picture of what's broken and why.
- **If at any point there are ambiguities or design decisions that require human input, STOP and ask for clarification.** Do not make assumptions about architectural decisions. The human can run `/speckit.clarify` to help resolve open questions.
- **Otherwise, proceed through the full workflow autonomously.**
- Key architectural decisions that may need human input:
  - DO-per-task vs. shared DO design
  - Alarm-per-step vs. single alarm with step dispatch
  - Migration strategy (parallel run vs. cutover)
  - How to handle in-flight tasks during migration

---

## Context: Why This Exists

The **single most critical failure** in the current task delegation system is that the entire orchestration pipeline (`executeTaskRun()`) runs inside a Cloudflare Worker `waitUntil()` call. This is a fire-and-forget background context with **no durability guarantees**.

When the Worker is recycled mid-execution:
- The async function silently stops — no exception thrown, no catch block runs
- The only evidence is the `executionStep` breadcrumb in D1
- The workspace may become ready on the VM, but nobody advances the task
- Recovery depends on a cron job that runs every 5 minutes (up to 5 min blind spot)
- The admin errors tab shows nothing (no error database entry)

**This is not a bug — it's a design-level problem.** `waitUntil()` was never meant for multi-minute orchestration spanning external API calls, VM provisioning, and polling loops.

### Research References (READ THESE FIRST)

- **Complete flow map**: `docs/task-delegation-flow-map.md`
  - Section "End-to-End Flow: Chat Submit Task" — the full 6-phase pipeline
  - Section "Known Weak Points" — all 8 failure modes, especially #1 (waitUntil), #6 (silent failures)
  - Section "Recommended Fixes" — P0 recommendation for DO migration
  - Section "Configuration Reference" — all timeout/threshold env vars
  - Section "Debugging Checklist" — how failures manifest today
- **Deep analysis**: `docs/notes/task-delegation-system-analysis.md`
  - Section "The executeTaskRun() Orchestration" — Mermaid flowchart of all steps
  - Section "The Core Problem: waitUntil Reliability" — detailed explanation of the blind spot
  - Section "Analysis of Specific Error" — real-world failure scenario breakdown
  - Section "Recommendations" — immediate, medium-term, quick-win fixes
- **Current implementation**: `apps/api/src/services/task-runner.ts` — the function to replace
- **Current task status service**: `apps/api/src/services/task-status.ts` — transition validation
- **Current node selector**: `apps/api/src/services/node-selector.ts` — node selection logic
- **Current node agent client**: `apps/api/src/services/node-agent.ts` — VM communication
- **Existing DOs**: `apps/api/src/durable-objects/node-lifecycle.ts`, `apps/api/src/durable-objects/project-data.ts` — reference patterns
- **Wrangler config**: `apps/api/wrangler.toml` — DO bindings, cron triggers

---

## Problem Statement (Detailed)

### What Currently Happens

```
User submits task
    → API route creates task in D1 (status=queued)
    → waitUntil(executeTaskRun())
        → Select node (D1 queries + DO claim)           ~1-5s
        → Provision node if needed (Hetzner API)         ~60-120s
        → Wait for agent health (polling)                ~5-120s
        → Create workspace on VM (HTTP POST)             ~1s
        → Poll D1 for workspace readiness (backoff)      ~30-600s
        → Create agent session on VM (HTTP POST)         ~1s
        → Mark task in_progress
    ← Worker may be recycled at ANY point above
```

Total time in `waitUntil`: **2-15 minutes** for a provisioning flow, or **30-600 seconds** even for warm nodes.

### What Should Happen

```
User submits task
    → API route creates task in D1 (status=queued)
    → Create/wake TaskRunner DO for this task
    → DO alarm fires: execute step 1 (node selection)
        → Persist result, schedule next alarm
    → DO alarm fires: execute step 2 (provisioning or skip)
        → Persist result, schedule next alarm
    → ... (each step is an independent alarm callback)
    → DO survives Worker recycling — state is durable
    → No polling loops — callbacks advance the DO directly
    → Real-time status via DO's built-in WebSocket support (optional)
```

### The Execution Steps to Make Durable

Each of these currently happens sequentially in one long async function. They need to become independent, alarm-driven steps:

| Step | Current Behavior | Duration | Durable Requirement |
|------|-----------------|----------|-------------------|
| `node_selection` | Query D1, try warm pool, evaluate capacity | ~1-5s | Persist selected nodeId |
| `node_provisioning` | Hetzner API create server | ~60-120s | Persist Hetzner server ID, poll via alarm |
| `node_agent_ready` | Poll health endpoint every 5s, 120s timeout | ~5-120s | Alarm-driven polling with backoff |
| `workspace_creation` | HTTP POST to VM agent, returns 202 | ~1s | Persist workspace request, await callback |
| `workspace_ready` | Poll D1 for status change | ~30-600s | **Eliminate polling** — callback advances DO (see TDF-5) |
| `agent_session` | HTTP POST to VM agent | ~1s | Persist session creation |
| `running` | Agent is active on VM | minutes-hours | Track via callbacks |
| `awaiting_followup` | Agent completed, idle timer | 15 min | Timer is already in ProjectData DO |

### Key Design Constraints

1. **Alarm-driven, not polling-driven**: Each step should complete quickly. Long waits (provisioning, workspace readiness) should be handled by scheduling a future alarm and returning.
2. **Idempotent steps**: If a step runs twice (alarm fires after Worker restart), it must produce the same result. Check-then-act with persisted state.
3. **Callback-driven advancement**: Instead of polling for workspace readiness, the `/workspaces/{id}/ready` callback should directly poke the DO to advance (coordinated with TDF-5).
4. **Error isolation**: A failure in step N should NOT require re-running steps 1 through N-1. Each step's result is persisted.
5. **Observability**: Each step transition should be logged to Workers Observability AND written to the error database on failure.
6. **Graceful migration**: Existing in-flight tasks must either complete under the old system or be migrated.

---

## What the Spec Must Address

The specification (via `/speckit.specify`) should cover:

1. **DO design**: One DO per task? Or a shared DO that manages multiple tasks? Trade-offs of each.
2. **State model**: What state does the DO persist between alarms? How is it structured?
3. **Alarm strategy**: One alarm per step? Single alarm with step dispatch? Retry alarms on transient failure?
4. **Callback integration**: How does the `/workspaces/{id}/ready` callback find and wake the right DO?
5. **Concurrency**: What happens if two callbacks arrive simultaneously? What about alarm + callback race?
6. **Error handling**: How are transient vs. permanent failures distinguished? What's the retry policy?
7. **Observability**: How are step transitions logged? How do failures reach the error database?
8. **Migration strategy**: How do we transition from `waitUntil` to DO without breaking in-flight tasks?
9. **Testing strategy**: How do we test alarm-driven flows with Miniflare? How do we simulate Worker restarts?
10. **Configuration**: Which timeouts/thresholds should be configurable? How does the DO read env vars?

---

## Testing Requirements (High-Level — Details in Spec)

The implementation must include:

### Unit Tests
- Each step handler in isolation with mocked dependencies
- State machine transitions within the DO
- Idempotent step execution (run twice, same result)
- Error handling and retry logic for each step

### Integration Tests (Miniflare DO)
- Full pipeline with mocked external services (Hetzner API, VM agent)
- Alarm-driven step progression
- Callback-driven advancement (webhook pokes DO)
- Concurrent alarm + callback handling
- DO restart recovery (state persists across simulated restarts)

### End-to-End Tests
- Full flow: task submit → DO orchestration → mocked VM → completion
- Failure at each step → correct error state + cleanup
- Timeout at each step → stuck detection → recovery

### Chaos / Resilience Tests
- Kill DO mid-step, verify it resumes correctly on restart
- Deliver callback before DO expects it, verify queued/deferred handling
- Simultaneous task submissions, verify no resource conflicts

---

## Key Files

| File | Action |
|------|--------|
| `apps/api/src/services/task-runner.ts` | Replace with DO-based orchestration |
| `apps/api/src/durable-objects/` | New TaskRunner DO |
| `apps/api/wrangler.toml` | Add DO binding |
| `apps/api/src/routes/task-submit.ts` | Change to wake DO instead of waitUntil |
| `apps/api/src/routes/task-runs.ts` | Change to wake DO instead of waitUntil |
| `apps/api/src/routes/tasks.ts` | Callback handler wakes DO |
| `apps/api/src/routes/workspaces.ts` | Ready callback wakes DO |
| `apps/api/src/services/task-status.ts` | Used by DO for transitions (hardened in TDF-1) |
| `apps/api/src/services/node-selector.ts` | Called by DO's node_selection step |
| `apps/api/src/services/node-agent.ts` | Called by DO's provisioning/workspace steps |
| `apps/api/src/scheduled/stuck-tasks.ts` | Simplified — DO handles its own timeouts |

---

## Success Criteria

When this is complete:
- No task orchestration runs in `waitUntil()`
- Worker recycling cannot silently kill a task pipeline
- Each orchestration step survives independently
- Callbacks advance the pipeline without polling
- Failures are visible in the error database
- The stuck-task cron becomes a safety net, not the primary recovery mechanism
- All existing task functionality works identically from the user's perspective
