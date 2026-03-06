# Bug: ACP-Created Sessions Don't Persist Messages to DO

**Discovered**: 2026-03-06 during staging E2E testing
**Severity**: High — follow-up messages from project chat are lost on page reload

## Problem

When a user sends follow-up messages from the **project chat** view, the messages stream correctly via ACP (real-time token streaming works), but the agent's responses are **NOT persisted** to the ProjectData DO. On page reload or session switch, the follow-up responses disappear.

## Root Cause Analysis

The project chat creates a **separate agent session** on the VM via the ACP `switchAgent` flow:

1. Task runner creates the original task session (e.g., `01KK1EHAT09944SV056TDGH6AD`) with a MessageReporter configured to POST messages to the API → DO
2. Project chat connects via ACP WebSocket with the DO session ID (e.g., `d0dfde46-...-4841`)
3. ACP `switchAgent("claude-code")` creates a NEW agent session ("Chat 4841") on the VM
4. This new session likely does **NOT** have a MessageReporter configured because the ACP session creation flow doesn't provide a callback URL

## Evidence

- Workspace tab "Chat 4841" shows full conversation via ACP replay (delete + date responses visible)
- Project chat DO messages only show user prompts (optimistic adds) but no agent responses
- Message count stays at 37 (no new messages persisted after follow-ups)
- Original task session on workspace has its own complete messages (MessageReporter works for task-created sessions)

## Impact

- Follow-up messages from project chat are ephemeral — only visible during the active session
- Switching between conversations and coming back loses follow-up agent responses
- The grace period fix (10s ACP view after prompting) helps during the current session but doesn't solve persistence

## Acceptance Criteria

- [ ] Follow-up agent responses from project chat are persisted to the DO
- [ ] Reloading the project chat page shows all follow-up responses
- [ ] Switching between conversations preserves follow-up responses
- [ ] No duplicate messages when both ACP and MessageReporter report the same message

## Code Paths to Investigate

- `packages/vm-agent/internal/acp/` — ACP session creation, switchAgent handler
- `packages/vm-agent/internal/messagereport/reporter.go` — MessageReporter setup
- `packages/vm-agent/internal/server/workspaces.go` — handleCreateAgentSession (has callback URL)
- `apps/web/src/hooks/useProjectAgentSession.ts` — ACP WebSocket connection
- `apps/web/src/components/chat/ProjectMessageView.tsx` — handleSendFollowUp (line 479-483)

## Potential Solutions

1. **Configure MessageReporter for ACP-created sessions**: When `switchAgent` creates a new session, derive the callback URL from the workspace context
2. **Send follow-up user messages via DO WebSocket too**: Currently line 481 says "VM agent's MessageReporter handles persistence" — but it doesn't for ACP sessions. Could send via both paths with dedup.
3. **Unify through DO** (see related task: `2026-03-06-unify-project-chat-through-do-streaming.md`)
