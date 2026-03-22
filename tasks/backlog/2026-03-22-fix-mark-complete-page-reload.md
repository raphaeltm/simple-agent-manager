# Fix: Replace window.location.reload() with React state update after "Mark Complete"

## Problem

`handleMarkComplete()` in `ProjectMessageView.tsx:970` calls `window.location.reload()` after successfully completing a task. This causes a full page reload that destroys scroll position and reading context. The correct pattern already exists in `handleCloseConversation` at `ProjectChat.tsx:446-460` which uses `void loadSessions()`.

## Research Findings

- **Root cause**: `apps/web/src/components/chat/ProjectMessageView.tsx:970` — `window.location.reload()`
- **Correct pattern**: `apps/web/src/pages/ProjectChat.tsx:446-460` — `handleCloseConversation` uses `void loadSessions()` after mutation
- **Props interface**: `ProjectMessageViewProps` at line 28, currently has `projectId`, `sessionId`, `isProvisioning`
- **Component usage**: `ProjectChat.tsx:696` renders `<ProjectMessageView>` with key/projectId/sessionId/isProvisioning
- **`loadSessions`**: Defined at `ProjectChat.tsx:246-274`, refetches sessions and task titles
- **Other `window.location.reload()` uses**: `ErrorBoundary.tsx:36` (error recovery — legitimate), `PendingApproval.tsx:13` (auth state polling — legitimate)

## Implementation Checklist

- [ ] Add `onSessionMutated?: () => void` prop to `ProjectMessageViewProps` interface
- [ ] Replace `window.location.reload()` with `onSessionMutated?.()` call in `handleMarkComplete`
- [ ] Add `onSessionMutated` to `useCallback` dependency array
- [ ] Pass `onSessionMutated={() => { void loadSessions(); }}` from `ProjectChat.tsx` to `<ProjectMessageView>`
- [ ] Create `.claude/rules/15-no-page-reload-on-mutation.md` rule file
- [ ] Verify `ErrorBoundary.tsx` and `PendingApproval.tsx` uses are acceptable (already confirmed)

## Acceptance Criteria

- [ ] Clicking "Mark Complete" refreshes session list without full page reload
- [ ] User's scroll position and context are preserved
- [ ] New rule file prevents this class of mistake in the future
- [ ] No other `window.location.reload()` instances after mutations exist in the codebase

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx`
- `apps/web/src/pages/ProjectChat.tsx`
- `.claude/rules/06-technical-patterns.md`
