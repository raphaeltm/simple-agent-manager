# Replace Close Conversation Bottom Bar with Inline Idle Action

## Problem

The "Close conversation" button appears as a full-width bottom bar (~60px) at the bottom of idle conversation-mode sessions in project chat. It's visually heavy, wastes vertical space (especially on mobile), and its purpose is unclear to users who don't think about compute costs. The existing "Complete" button in the expanded session header already handles task-mode completion.

## Solution

Replace the bottom bar with a subtle inline action that appears in the message stream after the last agent message when the session is idle (Option C from the prototypes uploaded to `/prototypes/close-conversation/` in the library).

## Research Findings

### Key Files
- `apps/web/src/pages/project-chat/index.tsx` — Contains the bottom bar IIFE (lines 288-307) that renders the "Close conversation" button
- `apps/web/src/pages/project-chat/useProjectChatState.ts` — Contains `handleCloseConversation` callback (lines 450-464) and close state (`closingConversation`, `closeError`)
- `apps/web/src/components/project-message-view/index.tsx` — Main message view component; idle indicator should be rendered here after the Virtuoso list
- `apps/web/src/components/project-message-view/SessionHeader.tsx` — Has the "Complete" button (lines 525-536) — keep as-is
- `apps/web/src/lib/chat-session-utils.ts` — `getSessionState()` returns 'idle' when `session.isIdle || session.agentCompletedAt`

### Conditions for showing the inline idle action
- Session has a `taskId` (it's task-backed)
- Session state is `idle` (from `getSessionState`)
- Task is conversation-mode (`taskEmbed?.taskMode === 'conversation'`)

### Close action
- `closeConversationTask(projectId, taskId)` — POST to `/api/projects/:id/tasks/:taskId/close`
- Sets task status to 'completed', stops the DO session
- Already wired up as `handleCloseConversation` in `useProjectChatState`

## Implementation Checklist

- [ ] Remove the bottom bar IIFE from `project-chat/index.tsx` (lines 288-307)
- [ ] Remove `closingConversation` and `closeError` from the return value of `useProjectChatState` (if no longer used elsewhere)
- [ ] Add `onCloseConversation` optional callback prop to `ProjectMessageView`
- [ ] Add `closingConversation` and `closeError` props (or just inline the state in `ProjectMessageView`)
- [ ] In `ProjectMessageView`, render a subtle inline idle indicator below the message list when session is idle + conversation-mode task — with "End session" link
- [ ] Pass `handleCloseConversation`, `closingConversation`, `closeError` from `project-chat/index.tsx` to `ProjectMessageView`
- [ ] Style the inline indicator to match the prototype: small text, clock icon, "Agent idle | End session" link
- [ ] Verify on desktop and mobile viewports with Playwright visual audit

## Acceptance Criteria

- [ ] The full-width "Close conversation" bottom bar no longer appears
- [ ] When a conversation-mode session is idle, a subtle "Agent idle | End session" line appears after the last message
- [ ] Clicking "End session" closes the conversation (same behavior as old button)
- [ ] The "Complete" button in the expanded session header still works as before
- [ ] No horizontal overflow on mobile (375px)
- [ ] The inline indicator does NOT appear for task-mode sessions or active/terminated sessions

## References

- Prototype screenshots: library `/prototypes/close-conversation/`
- Rule: `.claude/rules/16-no-page-reload-on-mutation.md` — mutation must update via React state, not page reload (already handled by existing `handleCloseConversation`)
