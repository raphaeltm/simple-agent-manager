# Fix: "New Chat" Button in Session Sidebar Immediately Redirects Back

**Created**: 2026-02-28
**Status**: Active
**Priority**: High
**Estimated Effort**: Small
**Branch**: `fix/new-chat-sidebar-auto-select`

## Bug Description

Clicking the "+ New" button in the `SessionSidebar` on the project chat page does not work. Instead of showing the new chat input, the user is immediately redirected back to the most recent existing session. The "What do you want to build?" prompt never appears (or appears for a single frame before vanishing).

### Steps to Reproduce

1. Navigate to a project that has at least one existing chat session
2. The project chat page loads and auto-selects the most recent session
3. Click the "+ New" button in the sidebar header
4. **Expected**: The main content area shows the new chat input with "What do you want to build?"
5. **Actual**: The user is immediately bounced back to the most recent session

## Root Cause Analysis

The bug is in `apps/web/src/pages/ProjectChat.tsx` in the auto-select effect (lines ~175-187).

### The auto-select effect (BEFORE fix)

```tsx
// Auto-select the most recent session if none is selected and not provisioning
useEffect(() => {
  if (!sessionId && sessions.length > 0 && !loading && !provisioning) {
    const mostRecent = sessions[0];
    if (mostRecent) {
      navigate(`/projects/${projectId}/chat/${mostRecent.id}`, { replace: true });
    }
  }
}, [sessionId, sessions, loading, projectId, navigate, provisioning]);
```

### Why it breaks "New Chat"

1. `handleNewChat()` navigates to `/projects/:id/chat` (no `sessionId` param)
2. The component re-renders with `sessionId = undefined`
3. The auto-select effect fires: `!sessionId` is true, `sessions.length > 0` is true
4. It unconditionally navigates to the most recent session
5. The user never sees the new chat input

The effect has **no way to distinguish** between "initial page load with no session selected" (where auto-select is desired) and "user explicitly clicked New Chat" (where auto-select must be suppressed).

### Why this only affects projects with existing sessions

When `sessions.length === 0`, the auto-select effect's condition is false, so the new chat input shows correctly. The bug only manifests when there are existing sessions to redirect to.

## Data Flow Trace

```
1. User clicks "+ New" in SessionSidebar
   -> SessionSidebar.tsx: onNewChat prop callback

2. handleNewChat() fires
   -> ProjectChat.tsx:handleNewChat()
   -> navigate(`/projects/${projectId}/chat`, { replace: true })

3. React Router re-renders ProjectChat with sessionId=undefined
   -> useParams() returns { sessionId: undefined }

4. Auto-select effect fires (BUG)
   -> !sessionId (true) && sessions.length > 0 (true) && !loading (true)
   -> navigate(`/projects/${projectId}/chat/${mostRecent.id}`, { replace: true })

5. User is bounced back to the most recent session
```

## Fix

Add a `useRef` flag (`newChatIntentRef`) that tracks whether the user explicitly clicked "New Chat". The auto-select effect checks this flag and skips redirection when it's true.

### Key changes in `ProjectChat.tsx`

1. **Add ref**: `const newChatIntentRef = useRef(false)`
2. **Set true in handleNewChat**: `newChatIntentRef.current = true` before navigating
3. **Guard auto-select effect**: `if (newChatIntentRef.current) return;`
4. **Reset on session select**: `newChatIntentRef.current = false` in `handleSelect`
5. **Reset on submit**: `newChatIntentRef.current = false` in `handleSubmit` after successful task creation

### Why `useRef` instead of `useState`

- A ref doesn't trigger re-renders when set, avoiding unnecessary effect re-runs
- The flag is synchronous — it must be set before the navigation triggers the effect
- It persists across re-renders within the same component instance (React reconciler reuses the component because both `chat` and `chat/:sessionId` routes render the same `<ProjectChat />` type)

### Edge cases verified

| Scenario | Expected Behavior | Ref State |
|----------|------------------|-----------|
| Initial page load, no session selected | Auto-select most recent | `false` -> auto-select fires |
| Click "+ New" | Show new chat input | `true` -> auto-select skipped |
| Click "+ New" then select existing session | Show selected session | `true` -> `false` on select |
| Click "+ New" then submit new task | Navigate to new session | `true` -> `false` on submit |
| Navigate away from project and back | Auto-select most recent | Component remounts with `false` |
| Sessions reload during "New Chat" view | Stay on new chat input | `true` persists across re-renders |

## Files Changed

| File | Change |
|------|--------|
| `apps/web/src/pages/ProjectChat.tsx` | Add `newChatIntentRef` guard to auto-select effect |
| `apps/web/tests/unit/pages/project-chat.test.tsx` | New test file with 5 test cases |

## Test Plan

- [x] Research and root cause analysis
- [x] Implement the ref-based guard in `ProjectChat.tsx`
- [x] Add unit tests covering:
  - [x] No sessions -> shows new chat input
  - [x] Auto-selects most recent session on initial load
  - [x] "+ New" click shows new chat input (does NOT redirect back)
  - [x] Selecting a session after "+ New" clears the intent flag
  - [x] Task submission clears intent and navigates to new session
- [x] Run `pnpm typecheck` and `pnpm lint`
- [x] Run unit tests
- [ ] Push and verify CI passes
