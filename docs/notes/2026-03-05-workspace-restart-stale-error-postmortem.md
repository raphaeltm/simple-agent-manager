# Post-Mortem: Workspace Restart Shows Stale Error State

## What broke

When restarting a workspace that previously failed (e.g., devcontainer build error), the workspace detail page showed both the old failure state AND the new provisioning attempt simultaneously: header says "Creating" while main area shows "Provisioning Failed" with old error text and mixed step indicators.

## Root cause

Three independent state sources were not cleared on restart/rebuild:

1. **KV boot logs** (`bootlog:<workspaceId>`): The restart route (`apps/api/src/routes/workspaces.ts`) cleared `errorMessage` in D1 but did not call `writeBootLogs()` to clear KV. Old failed step entries persisted and were displayed alongside new progress.
2. **React `errorMessage` state**: `handleRestart()` in `apps/web/src/pages/Workspace.tsx` set `status: 'creating'` optimistically but did not clear `errorMessage`, leaving the error banner visible during the ~5s polling gap.
3. **React `bootLogs` state**: Same handlers did not clear `bootLogs`, so old step indicators (with failed/completed states from the previous attempt) persisted until polling replaced them.

This was present since the boot log streaming feature was introduced — the restart/rebuild routes were never updated to clear the new KV-based boot log state.

## Timeline

- Boot log streaming feature added (original implementation)
- Restart/rebuild routes updated to clear D1 `errorMessage` but KV boot logs not addressed
- 2026-03-05: Discovered during manual QA testing
- 2026-03-05: Fixed in this PR

## Why it wasn't caught

1. **No integration test for the restart flow**: The restart endpoint had no test verifying that all state sources (D1 status, D1 errorMessage, KV boot logs) were cleared together.
2. **State scattered across stores**: Workspace error state lives in both D1 (errorMessage) and KV (boot logs), making it easy to clear one and miss the other.
3. **Optimistic UI updates incomplete**: The React handlers only updated `status` but not the error-related fields, creating a visual gap between the optimistic update and the next poll.

## Class of bug

**Incomplete state cleanup across multiple stores.** When a lifecycle action (restart/rebuild) needs to reset state, and that state is spread across multiple storage backends (D1 + KV) and client-side caches (React state), it's easy to clear some but not all sources.

## Process fix

No new process rules added — this class of bug (multi-store state cleanup) is already covered by the existing data flow tracing requirement in `.claude/rules/10-e2e-verification.md`. The fix was straightforward once identified through QA testing.
