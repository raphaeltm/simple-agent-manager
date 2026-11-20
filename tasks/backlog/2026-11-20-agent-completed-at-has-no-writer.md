# `chat_sessions.agent_completed_at` has no writer

## Problem

`ProjectData.markAgentCompleted` (`packages/project-data/src/do/index.ts`, `do/sessions.ts:markAgentCompleted`)
is the only writer of `chat_sessions.agent_completed_at`, and nothing calls it outside tests. The column
is cleared on wake and mirrored to D1 `session_summaries`, and the web app still reads
`agentCompletedAt` / `isIdle` to label a chat idle (`apps/web/src/lib/chat-session-utils.ts`).
So the "idle" label in the chat list can only come from `isIdle` or a live
`session.agent_completed` event, and the stored column is never evidence of anything.

## Context

Found 2026-11-20 while fixing the Project Overview's Running now (PR #2921), which had keyed on this
column and on the latched `tasks.execution_step`. Running now now reads the ProjectData activity
mirror (`listWorkingChatSessionIds`) instead.

## Acceptance Criteria

- [ ] Decide: derive the chat list's idle label from the activity mirror (as Running now does), or
      wire a real writer at turn end (`recordTurnEnd` / idle activity report).
- [ ] Remove the dead writer and column readers, or the dead label path, whichever is not chosen.
- [ ] A test drives a real turn end and asserts the chat list's idle label.
