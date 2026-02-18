# Reliable Git Status Badge

**Created**: 2026-02-17
**Size**: Small
**Area**: UI (`apps/web`)

## Problem

The git changes badge in the workspace header doesn't reliably show uncommitted changes. The current implementation fetches git status **once** on initial load and never refreshes, so:

- If the fetch fails (VM Agent slow, transient network issue), the badge silently stays blank forever
- Changes made during a session (edits, commits, stashes) never update the badge
- Users see no badge and assume "no changes" when in reality the fetch failed or the data is stale

## Root Cause

`Workspace.tsx:529-541` — a single `useEffect` calls `getGitStatus()` once when `workspace.url`, `terminalToken`, `id`, or `isRunning` change. No polling, no retry, silent `.catch()`.

## Key Files

| File | Role |
|------|------|
| `apps/web/src/pages/Workspace.tsx` (L529-541) | One-shot fetch + state (`gitChangeCount`, `gitStatus`) |
| `apps/web/src/lib/api.ts` (L405-416) | `getGitStatus()` API call |
| `apps/web/src/components/GitChangesButton.tsx` | Badge display component |
| `apps/web/src/components/GitChangesPanel.tsx` | Panel with its own fetch + manual refresh (doesn't update badge) |
| `apps/web/src/components/WorkspaceSidebar.tsx` (L240-280) | Sidebar git summary (same stale data) |

## Proposed Fix

- [ ] Add polling interval (e.g., every 30s) to periodically refresh git status while workspace is running
- [ ] Add retry with backoff on initial fetch failure (e.g., 3 attempts)
- [ ] When GitChangesPanel refreshes, propagate updated status back to the badge (lift refresh callback or use shared state)
- [ ] Consider a lightweight "stale" indicator or subtle visual cue if the last fetch failed

## Out of Scope

- Real-time git status via WebSocket/file watcher (over-engineering for now)
- Changing the VM Agent git endpoints themselves
