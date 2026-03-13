# Fix: Session ID Mismatch Between Chat UI and VM Agent

## Problem

When a user opens a project chat after task submission, follow-up messages go to a **duplicate** agent session instead of the one created by TaskRunner. Messages appear to "clear out" because the view switches to showing ACP items from the empty duplicate session.

**Root cause**: Two different session ID spaces exist:
- **Chat session ID** (from ProjectData DO) — used by the UI
- **Agent session ID** (ULID from TaskRunner) — used by the VM agent

The UI passes the chat session ID to the VM agent WebSocket, which doesn't recognize it and creates a new session.

## Research Findings

| Component | File | Issue |
|-----------|------|-------|
| TaskRunner | `apps/api/src/durable-objects/task-runner.ts:796` | Generates ULID agent session ID, stores in D1 |
| useProjectAgentSession | `apps/web/src/hooks/useProjectAgentSession.ts:141` | Passes chat session ID to `/agent/ws?sessionId=` |
| VM agent WS handler | `packages/vm-agent/internal/server/agent_ws.go:58` | Creates duplicate session when chat ID not found |
| Chat API | `apps/api/src/routes/chat.ts:169` | Session detail response missing `agentSessionId` |
| ProjectMessageView | `apps/web/src/components/chat/ProjectMessageView.tsx:365` | Passes chat `sessionId` to `useProjectAgentSession` |

## Implementation Checklist

- [ ] **API**: Add D1 lookup for active agent session ID in `GET /sessions/:sessionId` response
- [ ] **UI type**: Add `agentSessionId` field to `ChatSessionResponse` in `apps/web/src/lib/api.ts`
- [ ] **UI component**: Pass `session.agentSessionId ?? sessionId` to `useProjectAgentSession` in ProjectMessageView
- [ ] **Tests**: Add unit test for API route returning `agentSessionId`
- [ ] **Tests**: Add unit test for ProjectMessageView using `agentSessionId` when available
- [ ] **Staging**: Deploy and verify full chat lifecycle with follow-up messages via Playwright
- [ ] **Staging**: Verify messages don't clear when sending follow-up

## Acceptance Criteria

- [ ] Chat session detail API response includes `agentSessionId` when a running agent session exists
- [ ] ACP WebSocket connects using agent session ID (ULID), not chat session ID
- [ ] Follow-up messages route to the correct agent session
- [ ] Messages do not disappear when sending a follow-up
- [ ] Fallback: sessions without an agent session (manual chat) still work
- [ ] All existing tests pass
