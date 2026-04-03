# React Error #185 Infinite Render Loop (Recurring) — Post-Mortem

## What Broke

Opening the workspace view during an active chat session triggered React error #185 (infinite render loop). The workspace page would become unresponsive or crash. This was a recurring issue — a previous fix (commit `cf829f1a`) was incomplete.

## Root Cause

Three independent sources of infinite render loops existed in the workspace view hooks:

### Source 1: Polling effect feedback loop in `useWorkspaceCore.ts`

```typescript
// BEFORE (broken)
const loadWorkspaceState = useCallback(async () => {
  // ... sets workspace state
}, [id, terminalToken]);  // ← terminalToken causes callback identity change

useEffect(() => {
  void loadWorkspaceState();
  const interval = setInterval(() => {
    if (workspace?.status === 'running') void loadWorkspaceState();
  }, 5000);
  return () => clearInterval(interval);
}, [id, workspace?.status, loadWorkspaceState]);  // ← all three deps create feedback
```

The feedback loop: token refresh → new `loadWorkspaceState` identity → effect re-runs → calls `loadWorkspaceState()` immediately → `setWorkspace()` → `workspace?.status` changes → effect re-runs again → rapid cascade.

### Source 2: Orphan auto-resume without deduplication in `useSessionState.ts`

```typescript
// BEFORE (broken)
const orphanedSessions = useMemo(
  () => agentSessions.filter(s => isOrphanedSession(s)),
  [agentSessions, recentlyStopped]
);

useEffect(() => {
  for (const session of orphanedSessions) {
    void resumeAgentSession(id, session.id);  // ← fires every 5s
  }
}, [id, orphanedSessions]);  // ← new array ref on every poll cycle
```

`orphanedSessions` returns a new array reference on every `agentSessions` update (every 5 seconds from polling), causing the effect to fire repeatedly and make duplicate API calls.

### Source 3: `cleanup` callback in `useBootLogStream.ts` effect deps

The cleanup function was a `useCallback` passed as a dependency to two `useEffect` hooks. While mitigated by empty deps, this was fragile — any future change adding a dependency to `cleanup` would immediately create a loop.

## Timeline

- **Feb 27, 2026**: Chat message re-render loop fixed (d4c306c7) — separate but related issue
- **Apr 2, 2026**: ChatSession.tsx auto-select loop fixed (cf829f1a) — addressed one source
- **Apr 3, 2026**: Remaining sources identified and fixed (this PR) — addresses Sources 1-3

## Why It Wasn't Caught by the Previous Fix

The previous fix (cf829f1a) correctly identified the `ChatSession.tsx` auto-select pattern but did not trace all render cascades in the workspace view's component tree. The workspace view has multiple hooks (`useWorkspaceCore`, `useSessionState`, `useBootLogStream`) that each have their own effect chains, and the previous investigation only followed one path.

## Class of Bug

**Effect-dependency feedback loops**: A `useEffect` that depends on state it also updates, either directly or through an intermediary (callback identity, derived value). This class is particularly insidious because:

1. Each individual dependency looks correct in isolation
2. The loop only manifests when multiple effects interact
3. Polling patterns (setInterval inside useEffect) amplify the feedback
4. Token refresh patterns add time-delayed triggers that are hard to reproduce

## Process Fix

The following rule already exists in `.claude/rules/06-technical-patterns.md` (React Interaction-Effect Analysis) but was not followed during the previous fix:

> When adding or modifying a click handler, navigation call, or state setter in a component that has `useEffect` hooks, you MUST trace forward through every effect that could fire as a result of the state change.

**Additional guidance added**: When fixing an infinite loop in a component tree with multiple hooks, trace ALL hooks in the tree, not just the most obvious source. Use a systematic approach:

1. List all `useEffect` hooks in all hooks used by the component
2. For each effect, map: what state does it depend on? What state does it set?
3. Draw the dependency graph — if there are cycles, those are the loop sources
4. Fix ALL cycles, not just the first one found

## Fix Applied

1. **Ref pattern for polling effect**: `loadWorkspaceState` reads `terminalToken` from a ref instead of a closure dependency. The polling effect reads `loadWorkspaceState` and `workspace?.status` from refs instead of effect dependencies. The effect now depends only on `id`.

2. **Deduplication for orphan auto-resume**: A `Set<string>` ref tracks which session IDs have already been attempted. The effect only calls `resumeAgentSession` for new, unattempted sessions.

3. **Extracted cleanup to plain function**: `useBootLogStream` cleanup is now a plain function (not a callback), removing it from effect dependency arrays entirely.
