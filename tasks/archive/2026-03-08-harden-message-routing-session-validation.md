# Harden Message Routing with Session ID Validation

**Created**: 2026-03-08
**Type**: Bug Fix + Hardening
**Priority**: High
**Approach**: Use speckit flow (specify, plan, tasks, implement)

## Problem

Messages sent directly in a workspace (created during a project chat session) can end up in the wrong project chat session. When a user:

1. Creates a project chat session
2. Submits a task (agent starts working)
3. Opens the workspace directly and interacts with the agent there

Those workspace messages sometimes appear in the wrong project chat session when the user returns to the project view.

**Root Cause**: Missing validation gates at multiple points in the message routing chain:

1. **Workspace Message Endpoint** (`apps/api/src/routes/workspaces.ts:~1602`): Accepts messages with ANY `sessionId` without checking if it matches `workspace.chatSessionId`
2. **ProjectData DO** (`apps/api/src/durable-objects/project-data.ts:~162`): Only checks if session EXISTS, not if it's valid for the workspace
3. **VM Agent Message Reporter** (`packages/vm-agent/internal/messagereport/reporter.go`): Cached `sessionID` can be stale during warm node reuse

**User Preference**: Drop messages entirely rather than route them to the wrong session.

## Scope

### Constitution & Rules Updates
- [ ] Add Principle XIII: Fail-Fast Error Detection to constitution
- [ ] Add `.claude/rules/11-fail-fast-patterns.md` for operational guidance
- [ ] Update CLAUDE.md with new principle reference

### API Validation Hardening
- [ ] Add workspace.chatSessionId cross-validation at message endpoint
- [ ] Add project-scoped session validation in ProjectData DO
- [ ] Add structured logging for all validation failures with context (workspaceId, projectId, sessionId, taskId)
- [ ] Return explicit 400/422 errors for mismatched session IDs

### VM Agent Hardening
- [ ] Add validation in message reporter before enqueue
- [ ] Log when sessionId is cleared/changed during warm node transitions
- [ ] Handle race condition between warm node claim and SetSessionID()

### Tests
- [ ] Unit tests for session ID validation at workspace message endpoint
- [ ] Unit tests for ProjectData DO cross-validation
- [ ] Integration test: workspace messages with wrong sessionId are rejected
- [ ] Integration test: workspace messages with correct sessionId are accepted

## Acceptance Criteria

- [ ] Messages with mismatched sessionId are rejected with 400 error
- [ ] Messages without a valid sessionId are dropped (never silently routed)
- [ ] All validation failures logged with full context (workspaceId, projectId, sessionId, taskId)
- [ ] Constitution updated with Principle XIII (Fail-Fast Error Detection)
- [ ] Claude rules updated with fail-fast patterns
- [ ] All existing tests pass
- [ ] New tests prove the fix works

## Key Files

| File | Role |
|------|------|
| `apps/api/src/routes/workspaces.ts` | Workspace message endpoint |
| `apps/api/src/durable-objects/project-data.ts` | ProjectData DO message persistence |
| `packages/vm-agent/internal/messagereport/reporter.go` | VM agent message reporter |
| `packages/vm-agent/internal/server/workspaces.go` | VM agent workspace handler |
| `.specify/memory/constitution.md` | Project constitution |
| `.claude/rules/` | Agent behavioral rules |

## References

- CLAUDE.md: "Canonical IDs for identity" principle
- `.claude/rules/10-e2e-verification.md`: Data flow tracing requirements
- `docs/adr/004-hybrid-d1-do-storage.md`: Hybrid storage architecture
