# Command Palette: New Chat Action per Project

## Problem

Users cannot start a new chat from the global command palette (Cmd+K). Currently, the palette lets you navigate to a project (which opens the most recent chat), but there's no way to jump directly to a "new chat" for a specific project. The desired flow: type a few letters of a project name, then "new chat" — and selecting the result navigates directly to the new chat view.

## Research Findings

### Key Files
- `apps/web/src/components/GlobalCommandPalette.tsx` — Global command palette component
- `apps/web/src/hooks/useGlobalCommandPalette.ts` — Cmd+K toggle hook
- `apps/web/src/lib/fuzzy-match.ts` — Fuzzy matching (supports space-separated words)
- `apps/web/src/pages/ProjectChat.tsx` — Project chat page (handles new chat via `/projects/:id/chat` without sessionId)
- `apps/web/src/App.tsx` — Route definitions
- `apps/web/tests/unit/GlobalCommandPalette.test.tsx` — Existing tests

### Current Behavior
- Global palette has categories: Navigation, Projects, Nodes, Actions
- Projects are fetched on mount and fuzzy-matched against query
- Clicking a project navigates to `/projects/:id` (redirects to `/projects/:id/chat`)
- "New Chat" in ProjectChat is triggered by navigating to `/projects/:id/chat` without a sessionId
- `newChatIntentRef` in ProjectChat prevents auto-select from overriding the new chat view

### Design Decision
- Add a "Quick Actions" category that generates "{ProjectName} New Chat" entries for each project
- Fuzzy match target = `{projectName} New Chat` — so both "myproj new chat" and "new chat" match
- Navigation target = `/projects/:id/chat` (same as the existing new chat flow)
- Only show Quick Actions when query is non-empty (avoid flooding empty-state results)
- Icon: `MessageSquarePlus` from lucide-react

## Implementation Checklist

- [ ] Add `MessageSquarePlus` import to GlobalCommandPalette.tsx
- [ ] Generate "Quick Actions" results: for each project, create `{projectName} New Chat` action
- [ ] Only include Quick Actions when query is non-empty
- [ ] Quick Actions navigate to `/projects/:id/chat` and close the palette
- [ ] Apply same `MAX_RESULTS_PER_CATEGORY` cap to Quick Actions
- [ ] Insert Quick Actions category between Projects and Nodes in the results list
- [ ] Add tests: query "new chat" shows quick actions for all projects
- [ ] Add tests: query "api new chat" shows only matching project's new chat action
- [ ] Add tests: clicking a quick action navigates to correct project chat URL
- [ ] Add tests: empty query does NOT show quick actions
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test` — all pass

## Acceptance Criteria

1. Typing "new chat" in the command palette shows "New Chat" results for all projects
2. Typing a project name prefix + "new chat" (e.g., "myproj new chat") shows the matching project's New Chat action with high relevance
3. Selecting a "New Chat" result navigates to `/projects/:id/chat` (new chat view)
4. Quick Actions are not shown when the search query is empty
5. All existing tests continue to pass
6. New behavioral tests verify the feature

## References

- `.claude/rules/06-technical-patterns.md` — React interaction-effect analysis
- `apps/web/tests/unit/GlobalCommandPalette.test.tsx` — Test patterns to follow
