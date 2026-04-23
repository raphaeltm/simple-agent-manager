# Post-Mortem: Chat Session Routed to the Wrong Agent Session

## What Broke

On chat reload, recent assistant responses could appear briefly and then disappear once the UI attached to the live workspace connection. Persisted history existed, but the live chat session sometimes reconnected to the wrong underlying agent session.

## Root Cause

Commit `6fcb08f8` (`fix: resolve session ID mismatch in project chat (#354)`) introduced a heuristic in `apps/api/src/routes/chat.ts` that derived `agentSessionId` by selecting the most recent D1 `agent_sessions` row for the workspace. That was meant to avoid falling back to the chat session ID, but it used the wrong identity boundary: the canonical mapping is `acp_sessions.chat_session_id` inside the ProjectData Durable Object, not "latest session in this workspace."

Once a workspace had more than one agent session over time, `GET /api/projects/:projectId/sessions/:sessionId` could return an `agentSessionId` belonging to a different chat. The browser then merged persisted history for one chat session with live ACP state from another one.

## Timeline

- **2026-03-13**: `6fcb08f8` adds workspace-scoped D1 lookup for `agentSessionId`
- **2026-03-14**: `caa76524` keeps the same lookup but removes the status filter, preserving the workspace-scoped heuristic
- **2026-04-22**: User reports chat history appearing after refresh, then disappearing once the live connection settles

## Why It Wasn't Caught

1. The route logic was validated by code inspection, not a route-level regression test.
2. The fix that introduced the heuristic was solving a real bug, which made the workspace-scoped lookup look like a harmless implementation detail instead of a new identity contract.
3. The existing test note in `apps/api/tests/workers/route-auth-validation.test.ts` documented "do not filter by status" but not the more important invariant: agent-session lookup must remain chat-scoped.

## Class of Bug

**Wrong identity boundary**: a route resolved live state using a broader workspace-scoped heuristic instead of the narrower canonical chat-scoped identifier. This is a session-routing bug, not a storage bug.

## Process Fix

Add an explicit rule that whenever the UI bridges persisted chat history to live agent state, the handoff must use the canonical session-to-session mapping (`chatSessionId -> ACP session`) rather than a workspace-level proxy like "latest session on this workspace." Route-level tests should assert both the positive mapping and the absence of the broader heuristic.

## Fix

Update `apps/api/src/routes/chat.ts` to resolve `agentSessionId` via `projectDataService.listAcpSessions({ chatSessionId })` and add a regression test that fails if the route falls back to the old workspace-level D1 lookup.
