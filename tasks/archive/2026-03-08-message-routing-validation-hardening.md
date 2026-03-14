# Message Routing Validation Hardening

**Created**: 2026-03-08
**Status**: backlog
**Use Speckit**: Yes — full speckit flow (specify → clarify → plan → tasks → implement)

## Problem Statement

Messages sent from a workspace opened directly (not through project chat) end up in the wrong project chat session. When a user creates a project chat session, submits a task, then opens the workspace to interact with the agent directly, those messages occasionally or consistently get routed back into the project chat — potentially into the wrong session.

Root cause: the POST `/workspaces/:id/agent-sessions` endpoint (user-facing) does NOT pass `chatSessionId` to the VM agent's message reporter, so the reporter continues using whatever session ID was set from the previous task's cloud-init or the last `SetSessionID()` call.

## Research Findings

### The Message Chain (6 stages)

1. **API Route** (`apps/api/src/routes/workspaces.ts:871-947`): POST handler for agent sessions doesn't accept or forward `chatSessionId`
2. **Shared Types** (`packages/shared/src/types.ts`): `CreateAgentSessionRequest` interface lacks `chatSessionId` field
3. **Service Layer** (`apps/api/src/services/node-agent.ts:238-253`): `createAgentSessionOnNode()` HAS the `chatSessionId` parameter but it's never called with it from the user-facing route
4. **VM Agent** (`packages/vm-agent/internal/server/workspaces.go:518-576`): Handler accepts `chatSessionId` and sets it on reporter — but only when provided
5. **Message Reporter** (`packages/vm-agent/internal/messagereport/reporter.go`): `Enqueue()` uses current `sessionID` without validating it's non-empty
6. **Message Persistence** (`apps/api/src/routes/workspaces.ts:1602-1703`): Validates sessionId exists on each message but doesn't validate it matches the workspace's linked project chat sessions

### Key Validation Gaps

- `Enqueue()` silently uses empty/stale sessionID
- `SetSessionID()` accepts empty string without warning
- `sendBatch()` doesn't validate sessionID on messages before POST
- API messages endpoint doesn't validate sessionId belongs to the workspace's project

## Implementation Checklist

### Phase 1: Constitution & Rules
- [ ] Add "Fail Early, Fail Loud" principle to constitution (Principle XIII)
- [ ] Add Claude rule `.claude/rules/11-fail-early.md` for fail-fast patterns
- [ ] Update constitution version to 1.8.0

### Phase 2: VM Agent Hardening
- [ ] `Enqueue()`: Reject messages when sessionID is empty with structured error log
- [ ] `SetSessionID()`: Log warning and reject empty string
- [ ] `sendBatch()`: Validate all messages have non-empty sessionID before POST
- [ ] Add structured logging at each validation point

### Phase 3: API Hardening
- [ ] When creating agent session from workspace UI without chatSessionId, do NOT set reporter session ID (so messages get dropped, not misrouted)
- [ ] Add validation in POST `/workspaces/:id/messages` to verify sessionId belongs to workspace's project
- [ ] Add structured logging when messages are rejected

### Phase 4: Tests
- [ ] Unit tests for reporter rejecting empty sessionID
- [ ] Unit tests for reporter SetSessionID with empty string
- [ ] Integration test for agent session creation without chatSessionId
- [ ] Capability test: direct workspace interaction messages don't leak to project chat

## Acceptance Criteria

- [ ] Messages sent from direct workspace interaction (without project chat context) are dropped, never routed to wrong session
- [ ] All validation failures produce structured logs with enough context to debug
- [ ] Constitution includes fail-early principle
- [ ] Claude rules include fail-fast guidance
- [ ] All existing tests continue to pass
- [ ] Reporter Enqueue fails explicitly on empty sessionID

## References

- `apps/api/src/routes/workspaces.ts` — agent session creation, message persistence
- `apps/api/src/services/node-agent.ts` — createAgentSessionOnNode service
- `packages/vm-agent/internal/server/workspaces.go` — VM agent session handler
- `packages/vm-agent/internal/messagereport/reporter.go` — message outbox reporter
- `packages/shared/src/types.ts` — CreateAgentSessionRequest type
- `.specify/memory/constitution.md` — project constitution
