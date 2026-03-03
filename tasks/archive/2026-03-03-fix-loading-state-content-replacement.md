# Fix Loading States That Replace Existing Content

## Problem

Several components in the web app show full-page loading spinners that replace already-loaded content when data is being refreshed. This causes a jarring UX where users lose context and interactivity during background fetches.

## Research Findings

### Critical Bug
- **`ProjectMessageView.tsx:594`** — `if (loading) return <Spinner />` unconditionally replaces all chat messages with a spinner whenever `loading` is true, even when messages and session data are already displayed.

### Secondary Issue
- **`ProjectInfoPanel.tsx:45`** — `setLoading(true)` is called every time the panel opens via `loadData()`, replacing existing workspace/task data with a spinner on re-open.

### Already Safe (no changes needed)
- `ProjectChat.tsx:298` — guards with `loading && sessions.length === 0`
- `ChatSessionView.tsx:120` — guards with `loading && !session`
- `ProjectSessions.tsx:30` — guards with `loading && chatSessions.length === 0`
- `Dashboard.tsx`, `Projects.tsx`, `Nodes.tsx`, `Node.tsx` — `loading` is never re-set to `true` after initial load, so polls don't cause content replacement

## Implementation Checklist

- [ ] Fix `ProjectMessageView.tsx` — change `if (loading)` to `if (loading && messages.length === 0 && !session)` for initial-only spinner
- [ ] Add floating background refresh indicator in `ProjectMessageView.tsx` (small spinner in top-right when refreshing with data visible)
- [ ] Fix error display to show inline banner when session data exists, instead of replacing the view
- [ ] Fix `ProjectInfoPanel.tsx` — use `hasLoadedRef` to distinguish initial load from re-open
- [ ] Add `refreshing` state to `ProjectInfoPanel` with subtle spinner in header
- [ ] Verify build passes (`pnpm build`)
- [ ] Verify typecheck passes (`pnpm typecheck`)
- [ ] Run lint (`pnpm lint`)

## Acceptance Criteria

- [ ] Chat messages remain visible during any background data refresh
- [ ] Users can continue interacting with loaded UI elements during refreshes
- [ ] A subtle spinner indicates background refresh activity
- [ ] Full-page spinners only appear on initial load when no data exists yet
- [ ] Build, typecheck, and lint all pass

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx`
- `apps/web/src/components/project/ProjectInfoPanel.tsx`
- `.claude/rules/06-technical-patterns.md` (React interaction-effect analysis)
