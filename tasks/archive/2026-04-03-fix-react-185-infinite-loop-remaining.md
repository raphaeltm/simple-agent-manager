# Fix React Error #185 — Remaining Infinite Render Loop Sources

## Problem

React error #185 (infinite render loop) recurs in the workspace view during active chat sessions. The previous fix (commit `cf829f1a`) addressed ONE source — a `useEffect` in `ChatSession.tsx` that auto-selected sessions. However, multiple remaining sources exist in `useWorkspaceCore.ts` and `useSessionState.ts`.

## Research Findings

### Source 1: Polling Effect Feedback Loop in `useWorkspaceCore.ts` (CRITICAL)

**File:** `apps/web/src/pages/workspace/useWorkspaceCore.ts`, lines 106-160

The `loadWorkspaceState` callback depends on `[id, terminalToken]`. The polling effect at line 142 depends on `[id, workspace?.status, loadWorkspaceState]`. This creates a feedback loop:

1. Token refresh (every 5 min) changes `terminalToken` → invalidates `loadWorkspaceState` callback
2. Polling effect re-runs because `loadWorkspaceState` changed → calls `loadWorkspaceState()` immediately
3. `loadWorkspaceState()` calls `setWorkspace(data)` → `workspace?.status` may change
4. Effect re-runs again because `workspace?.status` changed
5. Repeat — rapid cascade of state updates triggers React error #185

### Source 2: Orphan Auto-Resume Loop in `useSessionState.ts` (HIGH)

**File:** `apps/web/src/pages/workspace/useSessionState.ts`, lines 216-221

`orphanedSessions` is a `useMemo` that returns a new array ref whenever `agentSessions` changes (every 5s from polling). The auto-resume effect depends on `orphanedSessions`, so it fires `resumeAgentSession()` API calls on every poll cycle — no deduplication.

### Source 3: `useBootLogStream.ts` cleanup in deps (MEDIUM)

**File:** `apps/web/src/hooks/useBootLogStream.ts`, lines 45-51, 53-134

`cleanup` callback is in effect dependency arrays. Currently mitigated by empty deps memo, but fragile.

## Implementation Checklist

- [ ] **Fix 1: Stabilize `loadWorkspaceState` in polling effect** — Use a ref to hold the latest `loadWorkspaceState` so the polling effect's interval closure always calls the current version without needing it in deps. Remove `loadWorkspaceState` from the polling effect dependency array.
- [ ] **Fix 2: Remove `workspace?.status` from polling effect deps** — Use a ref to track workspace status for the interval's conditional check. The effect should only re-run when `id` changes, not on every status update.
- [ ] **Fix 3: Deduplicate orphan auto-resume** — Track attempted session IDs in a ref. Only call `resumeAgentSession` for sessions not already attempted. Reset the ref when the session list fundamentally changes (not just on every poll).
- [ ] **Fix 4: Remove `cleanup` from `useBootLogStream` effect deps** — Call cleanup via ref or inline the cleanup logic to avoid the callback dependency.
- [ ] **Fix 5: Write regression tests** — Tests that detect useEffect dependency arrays containing callbacks that update their own dependencies (the infinite loop pattern).
- [ ] **Fix 6: Write post-mortem** — Document root cause, why previous fix was incomplete, and process improvements.

## Acceptance Criteria

- [ ] Opening workspace view during active chat session does NOT trigger React error #185
- [ ] Workspace polling continues to work (5s interval for workspace state)
- [ ] Token refresh does not cause polling effect to re-initialize
- [ ] Orphaned sessions are only auto-resumed once, not repeatedly
- [ ] Regression tests exist that would catch this class of bug
- [ ] Post-mortem documents the root cause and process fix
- [ ] All existing workspace view tests continue to pass

## References

- Previous fix: commit `cf829f1a` (branch `fix/react-185-infinite-loop`)
- `.claude/rules/06-technical-patterns.md` — React Interaction-Effect Analysis
- `docs/notes/2026-03-01-new-chat-button-postmortem.md` — Related pattern
