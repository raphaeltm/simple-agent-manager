# Simplify Web App Components and Pages

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - `Workspace.tsx` split into `apps/web/src/pages/workspace/` hooks (tabs, core, and navigation
>     with git state); boot-log streaming moved to `apps/web/src/hooks/useBootLogStream.ts`.
>   - ProjectChat subcomponents extracted to `apps/web/src/pages/project-chat/`; provisioning
>     state lives in `useProjectChatState.ts:250-257`. `lib/api.ts` is split into `lib/api/*.ts`.
> - **Still open:**
>   - `pages/workspace/index.tsx` is 679 lines (target under 500); `WorkspaceSidebar.tsx` is 741
>     lines with 23 props.
>   - A shared reconnect hook (backoff duplicated in `useChatWebSocket.ts:18-19,116` and
>     `useAdminLogStream.ts:36-70`); one command palette instead of two; a `lib/formatting.ts`
>     (`formatTokens` and `formatBytes` are each defined 4 times).
>   - Dead code: `apps/web/src/hooks/useProjectAgentSession.ts` plus its test (no consumer since
>     PR #978) and `apps/web/src/components/task/TaskSubmitForm.tsx` (556 lines, used only by
>     tests and a Playwright harness). Rule 01 says remove dead code.
> - **Moot/dropped:** merging thin wrapper pages; they are now `React.lazy` route chunks in tab
>   layouts (`apps/web/src/App.tsx:39,150,352,394`), as rule 60 requires.

**Status:** backlog
**Priority:** high
**Estimated Effort:** 1 week
**Created:** 2026-03-03

## Problem Statement

The web application (`apps/web/src/`) has several monolithic components that are difficult to understand, debug, and test. Key issues:

- `pages/Workspace.tsx` is 2,250 lines — manages terminal state, chat state, git state, file state, and UI state in a single component
- `pages/ProjectChat.tsx` is 751 lines with 4 inline subcomponents (`SessionItem`, `MobileSessionDrawer`, `ProvisioningIndicator`, `ChatInput`)
- `components/WorkspaceSidebar.tsx` accepts 22 props via deep prop drilling
- `lib/api.ts` is a ~1,000+ line monolith mixing auth, credentials, projects, tasks, workspaces, nodes, chat, and admin API calls
- `useChatWebSocket.ts` and `useAdminLogStream.ts` share ~70% identical WebSocket reconnection logic
- `GlobalCommandPalette.tsx` (547 lines) and `CommandPalette.tsx` (402 lines) duplicate search/rendering logic
- 15+ inline subcomponents defined inside page files instead of as separate files
- Multiple pages are thin 5-line wrappers that add routing complexity without value

## Acceptance Criteria

- [ ] Extract `Workspace.tsx` into composable parts:
  - Create `useWorkspaceGit.ts` hook for git state management
  - Create `useWorkspaceTabs.ts` hook for tab lifecycle
  - Move boot log streaming to dedicated hook
  - Target: main component < 500 lines
- [ ] Extract all inline subcomponents from `ProjectChat.tsx` to `components/chat/`:
  - `SessionItem.tsx`
  - `MobileSessionDrawer.tsx`
  - `ProvisioningIndicator.tsx`
  - `ChatInput.tsx`
- [ ] Create `useTaskProvisioning.ts` hook to encapsulate the two-polling-loop state machine in `ProjectChat.tsx`
- [ ] Reduce `WorkspaceSidebar.tsx` prop count — extract sidebar sections as individual components with context:
  - `SidebarTabsSection.tsx`
  - `SidebarGitSection.tsx`
  - `SidebarTokenUsageSection.tsx`
- [ ] Split `lib/api.ts` into domain-specific modules:
  - `lib/api/auth.ts`, `lib/api/projects.ts`, `lib/api/tasks.ts`, `lib/api/workspaces.ts`, `lib/api/nodes.ts`, `lib/api/chat.ts`, `lib/api/admin.ts`
  - Keep `lib/api/index.ts` as barrel re-export
- [ ] Create `useWebSocketWithReconnect.ts` base hook — eliminate ~250 lines of duplication between `useChatWebSocket.ts` and `useAdminLogStream.ts`
- [ ] Consolidate command palettes — shared `CommandPaletteUI.tsx` component + `useCommandPaletteSearch.ts` hook
- [ ] Move scattered helper functions (`formatTokens`, `formatBytes`, etc.) from components to `lib/formatting.ts`
- [ ] Consolidate thin wrapper pages (5-line Settings/Admin sub-pages) into tab-based layouts
- [ ] All existing tests pass after refactoring

## Key Files

- `apps/web/src/pages/Workspace.tsx` (2,250 lines)
- `apps/web/src/pages/ProjectChat.tsx` (751 lines)
- `apps/web/src/pages/CreateWorkspace.tsx` (491 lines)
- `apps/web/src/components/WorkspaceSidebar.tsx` (721 lines)
- `apps/web/src/components/GlobalCommandPalette.tsx` (547 lines)
- `apps/web/src/components/CommandPalette.tsx` (402 lines)
- `apps/web/src/components/GitDiffView.tsx` (579 lines)
- `apps/web/src/lib/api.ts`
- `apps/web/src/hooks/useChatWebSocket.ts` (261 lines)
- `apps/web/src/hooks/useAdminLogStream.ts` (264 lines)

## Approach

1. Start with lib/api.ts split and hook extractions — low risk, high impact
2. Extract inline subcomponents next — pure extraction, no behavior change
3. Decompose large page components last — requires more careful testing
4. Run `pnpm typecheck && pnpm lint && pnpm test` after each extraction
