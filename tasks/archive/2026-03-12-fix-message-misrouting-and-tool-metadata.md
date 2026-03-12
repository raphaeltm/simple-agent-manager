# Fix Message Misrouting & Tool Metadata Loss

**Created:** 2026-03-12
**Source:** Investigation doc `docs/notes/2026-03-11-message-misrouting-investigation.md`

## Problem

Three independent bugs cause message misrouting and tool metadata loss:

1. **Shared reporter singleton** (Critical): Single `messageReporter` per node means concurrent workspaces overwrite each other's session/workspace IDs, routing all messages to whichever workspace was created last.
2. **`safeParseJson` always returns null** (Critical): Prototype chain check (`'constructor' in parsed`) always returns `true`, silently dropping 100% of tool metadata for every message.
3. **Unvalidated session routing window** (Medium): Messages accepted with arbitrary sessionId when `chatSessionId` is NULL during the linking window.

Additionally, rich tool call information is missing on manually provisioned nodes — related to Bug 2 (all metadata dropped) and potentially Bug 1 (reporter late-init timing).

## Research Findings

### Key Files
- `packages/vm-agent/internal/messagereport/reporter.go` — Reporter singleton with shared mutable state
- `packages/vm-agent/internal/server/server.go:210-241` — Reporter created at boot, shared via `acpConfig`
- `packages/vm-agent/internal/server/workspaces.go:546-556` — SetSessionID/lateInit on agent session start
- `packages/vm-agent/internal/server/agent_ws.go:192-269` — SessionHost creation copies `s.acpConfig`
- `packages/vm-agent/internal/acp/session_host.go:562,1921` — SessionHost enqueues messages via reporter
- `apps/api/src/routes/workspaces.ts:113-123` — safeParseJson with broken prototype check
- `apps/api/src/routes/workspaces.ts:1613-1746` — Message ingestion endpoint
- `apps/api/src/durable-objects/task-runner.ts:906-962` — ensureSessionLinked with non-blocking failure
- `apps/api/src/services/observability.ts:71-103` — persistError function

### Existing Patterns
- Reporter uses nil-safe design, dual mutex (mu + flushMu)
- Late init path exists for manually provisioned nodes
- Adapter pattern bridges acp.MessageReporter ↔ messagereport.Reporter
- Per-workspace outbox partitioning possible via SQLite

## Implementation Checklist

### Bug 2: safeParseJson (one-line fix, highest impact)
- [ ] Replace `'key' in parsed` with `Object.hasOwn(parsed, 'key')` in `workspaces.ts:118`
- [ ] Add warning log when safeParseJson returns null for non-empty input
- [ ] Add unit test proving safeParseJson works with normal JSON objects
- [ ] Add unit test proving safeParseJson still blocks actual prototype pollution

### Bug 1: Per-workspace message reporter
- [ ] Create a reporter registry/map keyed by workspaceID in Server struct
- [ ] Create new reporter instance per workspace in handleCreateWorkspace or handleStartAgentSession
- [ ] Pass per-workspace reporter to SessionHost via GatewayConfig instead of shared acpConfig
- [ ] Clean up per-workspace reporter on workspace stop/delete
- [ ] Update lateInitMessageReporter to work with per-workspace model
- [ ] Update SetSessionID calls for warm node reuse
- [ ] Add test for concurrent workspace isolation

### Bug 3: Session linking window
- [ ] Reject messages (400) when workspace.chatSessionId is NULL instead of warning
- [ ] Add persistError call for routing warnings/errors
- [ ] Make D1 link failure in ensureSessionLinked blocking (or retry)

### Observability
- [ ] Add persistError calls to all message routing error paths in workspaces.ts
- [ ] Add structured logging for safeParseJson failures

### Post-mortem & docs
- [ ] Create post-mortem doc
- [ ] Update process rules if needed

## Acceptance Criteria
- [ ] Tool metadata is correctly persisted for all messages (safeParseJson works)
- [ ] Concurrent workspaces on same node have isolated message routing
- [ ] Messages rejected when workspace has no linked session
- [ ] Message routing errors visible in admin observability dashboard
- [ ] All existing tests pass + new tests for each fix
- [ ] Works on both auto-provisioned and manually provisioned nodes
