# Fix: Wake-Up Banner Disappears on Navigation

## Problem

When a sleeping session is waking up, the banner ("Waking and restoring session...") disappears if the user navigates away and comes back. Both banners in `project-message-view/index.tsx` (lines 564-585) are driven by ephemeral local React state that resets on component remount:

- Banner A (line 564): `lc.isResuming` — from `useConnectionRecovery`'s local `useState(false)`
- Banner B (line 576): `lc.sessionState === 'sleeping' && lc.agentActivity !== 'idle'` — `agentActivity` resets to `'idle'` on mount

The server already tracks `recoveryStatus: 'waking'` in D1's `session_snapshots` table, but this value is never surfaced to the client in the `SessionStateSnapshot` API response.

## Root Cause

`hydrateState()` in `useSessionLifecycle.ts` (lines 182-196) runs on mount to restore state from the server. It can't detect a waking session because:
1. `SessionStateSnapshot` doesn't include `recoveryStatus`
2. During VM provisioning, the server activity is still `'idle'` (no agent is running yet)
3. `sleepingWakePendingRef` resets to `false` on mount

## Research Findings

- `session_snapshots.recovery_status` column exists in D1 schema (schema.ts:1216)
- `claimSessionSnapshotRecovery` sets `recoveryStatus: 'waking'` server-side
- `getSessionState()` in DO's session-state.ts reads from DO-local SQLite — NOT D1
- The chat session detail route (`chat.ts:308-325`) calls `resolveChatAgentState()` for the state snapshot, then returns it directly
- The route already queries D1 for task details, so adding a D1 query for `recoveryStatus` is architecturally consistent
- The shared `SessionStateSnapshot` type is in `packages/shared/src/types/session.ts:339`

## Implementation Checklist

- [x] Add `recoveryStatus?: 'waking' | 'restored' | 'failed' | null` to shared `SessionStateSnapshot` type
- [x] In chat session detail route, query D1 `session_snapshots.recovery_status` for sleeping sessions and attach to response state
- [x] Add `recoveryStatus` to client-side `SessionStateSnapshot` interface in `sessions.ts`
- [x] In `hydrateState()`, when `recoveryStatus === 'waking'` and session is sleeping, set `agentActivity` to `'recovering'` so banner renders on mount
- [x] DO's `getSessionState()` — no change needed; field is optional on the type so undefined is correct for DO-sourced state
- [x] Add unit tests: positive (waking → recovering) and negative (null → idle)

## Acceptance Criteria

- [x] Navigating away from a waking session and returning shows the wake banner — hydrated from server recoveryStatus
- [x] Banner disappears once wake completes (recoveryStatus transitions to 'restored' or activity changes) — existing poll-based state update handles this
- [x] No new D1 queries for non-sleeping sessions (only query when sessionRecord.status is 'sleeping')
- [x] Existing wake flow (staying on page) still works correctly — hydrateState only adds a new branch, doesn't change existing ones
- [x] TypeScript compiles cleanly across all packages

## References

- Idea: `01M0D1WSZ1TD6ZE2YYE268SEHV`
- Rule 48: Stale-while-revalidate UI
- Rule 16: No page reload on mutation
