# Fail-Fast Patterns (Constitution Principle XIII)

## Identity Validation at System Boundaries

Every function or endpoint that processes data crossing a system boundary MUST validate identity fields before proceeding. This applies to:

- API endpoints receiving data from VM agents or external clients
- Durable Objects receiving delegated work from API routes
- VM agent functions processing control plane responses
- WebSocket handlers receiving messages from connected clients

### Required Validation Pattern

```typescript
// At API endpoint: validate workspace-session linkage
const workspace = await getWorkspace(workspaceId);
if (!workspace.projectId) {
  throw errors.badRequest('Workspace is not linked to a project');
}
if (workspace.chatSessionId && workspace.chatSessionId !== sessionId) {
  console.error('Message routing mismatch', {
    workspaceId,
    expectedSessionId: workspace.chatSessionId,
    receivedSessionId: sessionId,
    action: 'rejected',
  });
  throw errors.badRequest(
    `Session mismatch: workspace linked to session ${workspace.chatSessionId}, ` +
    `but messages target session ${sessionId}`
  );
}
```

### What to Validate

At every boundary, check:
1. **Required IDs are present** — workspaceId, projectId, sessionId must not be null/empty when required
2. **IDs are consistent** — workspace.chatSessionId must match the sessionId in the message
3. **IDs belong to the right scope** — sessions must belong to the correct project, workspaces to the correct project

### Project-Scoped Write Requirements

Every project-scoped write endpoint, MCP tool, service, or Durable Object RPC MUST verify ownership before mutating state and MUST include the project scope in the final write predicate when the backing table has `project_id`.

Required pattern:

1. Resolve the target row by its caller-supplied IDs before the write.
2. Reject if `target.projectId !== callerProjectId`; do not silently rely on "row not found" from a later update.
3. Log the rejection with caller projectId, target resource ID, target projectId, expected vs. received project IDs, and `action: 'rejected'`.
4. Include `project_id = ?` in the `UPDATE`/`DELETE` predicate as a final defence-in-depth guard.
5. When a Durable Object maintains project-local tracking state, verify the target is tracked in that project-local state before mutating global D1 rows.

### Structured Logging Requirements

Every validation failure MUST log:
- All relevant IDs (workspaceId, projectId, sessionId, taskId)
- What was expected vs. what was received
- The action taken (rejected, dropped, logged-and-continued)
- Enough context to reproduce the issue

```typescript
// Good: Full diagnostic context
console.error('Session validation failed', {
  workspaceId,
  projectId: workspace.projectId,
  expectedSessionId: workspace.chatSessionId,
  receivedSessionId: sessionId,
  messageCount: messages.length,
  action: 'rejected_batch',
});

// Bad: Minimal context
console.error('Invalid session');
```

### Drop vs. Error

- **Return 400/422 error** when the caller can fix the issue (e.g., wrong sessionId in request)
- **Silently drop** when the message cannot be routed and there's no caller to notify (e.g., VM agent background flush with stale session)
- **Never silently accept** — even if you drop the message, log the event

### Go (VM Agent) Patterns

```go
// Good: Validate before enqueue, fail with context
if sessionID == "" {
    slog.Error("messagereport: refusing to enqueue message without sessionID",
        "workspaceId", r.workspaceID,
        "messageId", msg.MessageID,
        "action", "dropped")
    return fmt.Errorf("messagereport: no session ID set")
}

// Bad: Silently use empty sessionID
_, err := r.db.Exec("INSERT INTO message_outbox ...", msg.MessageID, sessionID, ...)
```

## Quick Compliance Check

Before committing changes that handle identity-bearing data:
- [ ] All identity fields validated at function entry (not mid-execution)
- [ ] Validation failures logged with full diagnostic context
- [ ] Mismatched IDs cause rejection, not silent acceptance
- [ ] Nil/empty required IDs cause immediate failure, not silent no-op
