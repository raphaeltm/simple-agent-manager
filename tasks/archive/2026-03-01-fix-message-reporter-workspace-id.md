# Fix Message Reporter WorkspaceID Mismatch

**Date**: 2026-03-01
**Type**: Bug fix
**Severity**: Critical — agent messages never reach the chat UI

## Problem Statement

After PR #228 fixed the cloud-init env vars (`PROJECT_ID`, `CHAT_SESSION_ID`), the VM agent's
message reporter is now properly initialized (not nil). However, it still can't deliver messages
because it uses the **wrong workspace ID** in its HTTP POST URL.

### Root Cause

The message reporter is initialized at VM agent startup (`server.go:200`):

```go
msgReporterCfg.WorkspaceID = defaultWorkspaceScope(cfg.WorkspaceID, cfg.NodeID)
```

`defaultWorkspaceScope` returns `cfg.WorkspaceID` if non-empty, else `cfg.NodeID`. Since
`WORKSPACE_ID` is not set in cloud-init (the workspace doesn't exist yet when the VM is
provisioned), the reporter falls back to `nodeId`.

The reporter then POSTs to: `POST /api/workspaces/{nodeId}/messages`

The API endpoint looks up the workspace in D1 (`WHERE id = nodeId`) — no workspace has
that ID — returns 404. The reporter retries until exhaustion, messages accumulate in the
SQLite outbox, and are never delivered.

### Timeline

1. VM boots → reporter initialized with `WorkspaceID = nodeId` (wrong)
2. Task runner creates workspace → workspace gets its own UUID (e.g., `ws-abc123`)
3. Task runner starts agent → agent produces messages
4. Reporter POSTs to `/api/workspaces/{nodeId}/messages` → 404
5. Messages stuck in outbox forever

### Why It Wasn't Caught

- PR #228 fixed the reporter initialization (not nil) but didn't verify the POST URL
- The `WORKSPACE_ID` env var is not in cloud-init because the workspace is created after
  node provisioning
- No integration test exercises the complete POST URL path with a real workspace ID

## Research Findings

### Key Files

- `packages/vm-agent/internal/server/server.go:197-214` — Reporter initialization
- `packages/vm-agent/internal/server/server.go:100-105` — `defaultWorkspaceScope()`
- `packages/vm-agent/internal/messagereport/reporter.go:290-295` — URL construction in `sendBatch()`
- `packages/vm-agent/internal/messagereport/reporter.go:54-66` — `New()` constructor
- `packages/vm-agent/internal/messagereport/config.go` — Config struct and env loading
- `packages/vm-agent/internal/server/workspaces.go` — `handleCreateWorkspace()`
- `apps/api/src/routes/workspaces.ts:1477-1575` — Message ingestion endpoint

### Existing Patterns

- `SetToken(token string)` already exists on the Reporter for updating auth tokens after bootstrap
- `UpdateAfterBootstrap(cfg)` in server.go updates various post-init fields
- The reporter uses `r.mu` (sync.Mutex) for `authToken` — same pattern needed for `WorkspaceID`

## Implementation Checklist

### Go changes (vm-agent)

- [x] Add `SetWorkspaceID(id string)` method to `messagereport.Reporter`
  - Uses `r.mu.Lock()` for thread safety (same pattern as `SetToken`)
  - Stores in a new `r.workspaceID` field (separate from `r.cfg.WorkspaceID` for clarity)
  - `sendBatch()` reads the workspace ID under lock

- [x] Refactor `sendBatch()` URL construction to use the mutex-protected workspace ID
  - Read workspace ID under lock at start of method
  - If empty, log warning and return error (messages stay in outbox for retry)

- [x] Call `s.messageReporter.SetWorkspaceID(workspaceId)` from `handleCreateWorkspace`
  in server's workspace creation handler

- [x] Add unit test for `SetWorkspaceID` — verify URL construction uses updated ID

- [x] Add unit test for `sendBatch` with empty workspace ID — verify it returns error
  (not permanent error that would delete the batch)

### Post-mortem

- [x] Update post-mortem with Bug 5 details
- [x] Add process fix: capability test must verify POST URL, not just reporter initialization

## Acceptance Criteria

1. After workspace creation on a task-provisioned node, the reporter uses the correct
   workspace ID in the POST URL
2. Messages successfully reach the ProjectData DO and are persisted
3. Messages appear in the chat UI via WebSocket broadcast and/or polling fallback
4. Existing tests continue to pass
5. New tests verify the workspace ID update flow

## References

- PR #228: Fixed cloud-init env vars and WebSocket handlers
- `docs/notes/2026-03-01-tdf-message-relay-postmortem.md` — Previous post-mortem
- `packages/vm-agent/internal/messagereport/reporter_test.go` — Existing reporter tests
