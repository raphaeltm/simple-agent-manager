# Default to New Chat When Navigating to a Project

## Problem

When navigating to a project (`/projects/:id`), the app auto-selects the most recent chat session via a `useEffect` in `ProjectChat.tsx`. Users expect to land on the new chat screen instead, ready to start a new task.

## Research Findings

- **Key file**: `apps/web/src/pages/ProjectChat.tsx`
- **Auto-select effect** (lines 256-265): redirects to most recent session when `sessionId` is absent
- **`newChatIntentRef`** (lines 119-125): exists solely to prevent auto-select from overriding "New Chat" button clicks — becomes unnecessary when auto-select is removed
- **Test file**: `apps/web/tests/unit/pages/project-chat.test.tsx` has a test asserting auto-select behavior that needs updating
- **Post-mortem**: `docs/notes/2026-03-01-new-chat-button-postmortem.md` documents the original interaction-effect collision this ref was created to fix

## Implementation Checklist

- [ ] Remove the auto-select `useEffect` from `ProjectChat.tsx`
- [ ] Remove `newChatIntentRef` and all its usages (no longer needed)
- [ ] Remove unused `useLocation` import
- [ ] Update test: change "auto-selects most recent session" to verify new chat is shown instead
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test` to verify

## Acceptance Criteria

- Navigating to `/projects/:id` shows the "What do you want to build?" new chat screen
- Clicking an existing session in the sidebar still works
- The "+ New Chat" button still works
- Task submission still works
- All tests pass
