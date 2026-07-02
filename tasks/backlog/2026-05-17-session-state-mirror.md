# Session State Mirror: Resilient VM Agent → DO State Persistence

## Problem Statement

Two user-visible issues stem from the same architectural gap:

1. **Unreliable activity status**: "Agent is working..." in project chat is inconsistent — sometimes doesn't appear, sometimes sticks.
2. **Missing plan button**: The `StickyPlanButton` + `PlanModal` from `AgentPanel` (workspace direct chat) was never wired into project chat's working indicator bar.

Root cause: The DO's `reportActivity()` is broadcast-only (no write), combined with fire-and-forget HTTP callback from VM agent (no retry). Page loads/reconnects have no way to recover activity state.

## Research Findings

### Key Files
- `packages/vm-agent/internal/acp/session_host_reporting.go` — fire-and-forget `reportActivity()` (lines 163-217)
- `packages/vm-agent/internal/acp/session_host_prompt.go` — `markPromptStarted()` / `markPromptDone()` (lines 193-210)
- `apps/api/src/durable-objects/project-data/index.ts` — `reportActivity()` is broadcast-only (lines 315-318)
- `apps/api/src/routes/projects/agent-activity-callback.ts` — API route for activity callbacks
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` — UI activity state (initialized as 'idle', line 113)
- `apps/web/src/hooks/useChatWebSocket.ts` — reconnect catch-up (no activity state, lines 115-131)
- `packages/acp-client/src/components/StickyPlanButton.tsx` — existing plan button component
- `packages/acp-client/src/components/PlanModal.tsx` — existing plan modal component

### SAM Idea
`01KRT06SHG3PMX1MQADX5VNEW9` — full architectural spec with 7-layer implementation plan

## Implementation Checklist

### Layer 1: VM Agent — Retry + Enhanced Payload
- [ ] Add 1 retry with exponential backoff to `reportActivity()` in `session_host_reporting.go`
- [ ] Enhance activity payload to include `promptStartedAt`, `restartCount`, `agentType`, `statusError`

### Layer 2: API Route — Pass Enhanced Fields
- [ ] Update `agent-activity-callback.ts` to accept and forward new optional fields (`promptStartedAt`, `agentType`, `restartCount`, `statusError`)

### Layer 3: ProjectData DO — Session State Table + Persistence
- [ ] Create `session-state.ts` module with `session_state` table schema (DO SQLite)
- [ ] Implement `upsertSessionState()` — write activity + metadata on every callback
- [ ] Implement `getSessionState()` — read current state for catch-up
- [ ] Implement `reconcileStaleActivity()` — auto-heal stuck "prompting" states
- [ ] Wire `reportActivity()` in DO to persist THEN broadcast
- [ ] Wire plan extraction in `persistMessageBatch()` to update `current_plan_json`
- [ ] Add staleness check in existing `alarm()` handler
- [ ] Update terminal lifecycle methods (`markAgentCompleted`, `stopSession`, `failSession`) to update session_state

### Layer 4: Service Layer
- [ ] Add `getSessionState(projectId, sessionId)` service wrapper
- [ ] Update `reportAcpSessionActivity()` to pass enhanced fields to DO

### Layer 5: REST API — Include State in Catch-Up
- [ ] In `GET /sessions/:id` response, include `state` field from `getSessionState()`

### Layer 6: Shared Types
- [ ] Add `SessionStateSnapshot` interface to `packages/shared`
- [ ] Add `state` field to chat session detail response type

### Layer 7: Web UI — Hydrate + Plan Button
- [ ] Parse `state` from catch-up response in `useChatWebSocket.ts`
- [ ] Initialize `agentActivity` from server state instead of 'idle' in `useSessionLifecycle.ts`
- [ ] Track `currentPlan` state from catch-up + incoming plan messages
- [ ] Import `StickyPlanButton` + `PlanModal` from `@simple-agent-manager/acp-client`
- [ ] Wire plan button into "Agent is working" indicator bar in `project-message-view/index.tsx`
- [ ] Add elapsed time display (from `promptStartedAt`)

### Tests
- [ ] Unit test: `upsertSessionState` + `getSessionState` round-trip
- [ ] Unit test: staleness reconciliation auto-heals stuck prompting
- [ ] Unit test: plan extraction from persisted messages updates session_state
- [ ] Integration test: activity callback persists state and broadcasts
- [ ] Integration test: catch-up response includes current session state

## Acceptance Criteria

- [ ] Page load during active prompt shows "Agent is working..." immediately (no 3s delay)
- [ ] Plan button appears when agent has a plan, opens PlanModal with entries
- [ ] Activity indicator clears automatically within 5 minutes if VM agent crashes
- [ ] WebSocket reconnect restores correct activity state from server
- [ ] Single transient HTTP failure in activity callback does not lose the signal (retry)
- [ ] Existing behavior preserved: direct workspace chat still works, old VMs without enhanced payload still work

## References

- SAM Idea: `01KRT06SHG3PMX1MQADX5VNEW9`
- Post-mortem on callback auth: `docs/notes/2026-05-14-agent-activity-callback-auth-postmortem.md` (rule 34)
- ACP session routing: `.claude/rules/06-technical-patterns.md` (Canonical Session Routing)
