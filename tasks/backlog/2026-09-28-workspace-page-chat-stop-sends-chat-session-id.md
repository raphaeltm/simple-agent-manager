# Workspace page "Stop session" on a chat-linked workspace sends the chat session id (404)

## Problem

On the workspace page of any workspace linked to a project chat session (every Instant and task
workspace), the Sessions list shows one "Chat · active" row whose Stop control always fails with
**"Agent session not found"**. The agent is never stopped.

The web app builds that row from the chat session, not from an agent session:

- `apps/web/src/pages/workspace/useWorkspaceTabs.ts` (`workspaceTabs`): when `chatSessionId` is
  set, it emits a single `{ kind: 'chat', sessionId: chatSessionId, status: 'running' }` tab.
- `apps/web/src/components/WorkspaceSidebar.tsx` (`canStop`): the hardcoded `status: 'running'`
  shows "Stop session Chat", which calls `onStopSession(tab.sessionId)`; closing the tab does the
  same (`useWorkspaceTabs.ts`, `handleCloseWorkspaceTab`).
- `apps/web/src/pages/workspace/useSessionState.ts` (`handleStopSession`) → `stopAgentSession`
  (`apps/web/src/lib/api/workspaces.ts`) → `POST /api/workspaces/:id/agent-sessions/:sessionId/stop`
  with the **chat** session id.
- `apps/api/src/routes/workspaces/agent-sessions.ts` looks the id up in `agent_sessions.id`, finds
  nothing, and returns 404 `Agent session`. The lookup is the same on `main`.

## Context

Found on staging on 2026-09-28 while verifying PR #2173 (Instant in-place wake).

- Workspace `01M3M7ENA6Q4DYX8YRHZ6QXWN8`, chat session `783b2eaa-deaa-4f38-832a-985670001ffd`,
  agent session `01M3M7F0E8Y90ZDBA3WHJZQBW2`.
- Clicking "Stop session Chat" sent `POST .../agent-sessions/783b2eaa-.../stop` and got 404.
- The same route with the agent session id returned 200.
- The container was asleep and stayed asleep either way.

## Acceptance Criteria

- [ ] The Stop control on a chat-linked workspace stops that chat's agent session. Resolve it
      through the canonical chat → agent session mapping (ProjectData `acp_sessions.chat_session_id`,
      `.claude/rules/06-technical-patterns.md` "Canonical Session Routing"), not "latest in workspace".
- [ ] The row's status reflects the real agent session, not a hardcoded `running`, so a slept or
      stopped session does not offer Stop as if it were live.
- [ ] A rendered behavioral test clicks Stop on a chat-linked workspace and asserts the request
      targets the agent session id, with a control for a workspace without a linked chat session.
