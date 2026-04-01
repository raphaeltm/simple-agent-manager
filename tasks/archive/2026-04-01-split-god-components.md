# Split 3 Largest God-Components in apps/web/

## Problem

Three files in the web app violate the 500-line file size rule (`.claude/rules/18-file-size-limits.md`):

- `apps/web/src/pages/Workspace.tsx` — 2,224 lines
- `apps/web/src/components/chat/ProjectMessageView.tsx` — 1,882 lines
- `apps/web/src/pages/ProjectChat.tsx` — 1,716 lines

These need to be split into smaller, focused files without changing behavior.

## Research Findings

### Workspace.tsx (2,224 lines)
- **Main component**: lines 165–2138 (1,973 lines alone)
- **25 useState + 7 useRef + 35+ useCallback + 17 useEffect hooks**
- **Helper components**: `Toolbar` (2142–2163), `CenteredStatus` (2165–2193), `BootProgress` (2195–2224)
- **Logical sections**: terminal connection, git status polling, session management, worktree management, file browser navigation, git panel navigation, keyboard shortcuts, orphaned sessions, tab management, activity throttling, agent options
- **Imported by**: `apps/web/src/App.tsx` as `import { Workspace } from './pages/Workspace'`

### ProjectMessageView.tsx (1,882 lines)
- **Main component**: lines 382–1276
- **Helper components**: `AcpConversationItemView` (150–187), `SystemMessageBubble` (338–367), `SessionHeader` (1296–1689), `ContextItem` (1279–1287), `ConnectionBanner` (1692–1723), `AgentErrorBanner` (1729–1783), `FollowUpInput` (1786–1882)
- **Exported utilities**: `groupMessages` (111–128), `chatMessagesToConversationItems` (190–334)
- **Imported by**: `apps/web/src/pages/ProjectChat.tsx` as `import { ProjectMessageView } from '../components/chat/ProjectMessageView'`

### ProjectChat.tsx (1,716 lines)
- **Main component**: lines 105–950
- **Helper components**: `SessionItem` (956–1032), `MobileSessionDrawer` (1038–1223), `ProvisioningIndicator` (1233–1306), `ChatInput` (1320–1716)
- **Imported by**: `apps/web/src/App.tsx` as `import { ProjectChat } from './pages/ProjectChat'`

## Implementation Checklist

### 1. Split Workspace.tsx → `pages/workspace/` directory
- [ ] Create `pages/workspace/` directory
- [ ] Extract types and constants to `workspace/types.ts`
- [ ] Extract `useWorkspaceState.ts` — core state, workspace loading, terminal token setup
- [ ] Extract `WorkspaceTerminal.tsx` — terminal rendering, MultiTerminal integration
- [ ] Extract `WorkspaceFiles.tsx` — file browser panel + file viewer panel rendering
- [ ] Extract `WorkspaceGit.tsx` — git changes panel + git diff view rendering
- [ ] Extract `WorkspaceAgentPanel.tsx` — agent session management, create session, chat session rendering
- [ ] Extract `WorkspaceToolbar.tsx` — top toolbar with actions (stop, restart, rebuild, rename)
- [ ] Extract helper components (`Toolbar`, `CenteredStatus`, `BootProgress`) to `workspace/WorkspaceStatus.tsx`
- [ ] Create `workspace/index.tsx` — main component with layout, tab management, routing
- [ ] Delete original `Workspace.tsx`
- [ ] Update `App.tsx` import to `./pages/workspace`
- [ ] Verify no file exceeds 500 lines

### 2. Split ProjectMessageView.tsx → `components/project-message-view/` directory
- [ ] Create `components/project-message-view/` directory
- [ ] Extract `SessionHeader.tsx` — header bar with session title, state, context panel, actions
- [ ] Extract `MessageList.tsx` — message rendering, virtual scroll, ACP/DO source switching
- [ ] Extract `SessionFooter.tsx` — `FollowUpInput`, `ConnectionBanner`, `AgentErrorBanner` components
- [ ] Extract `useSessionMessages.ts` — message loading, pagination, merging, WebSocket handling
- [ ] Extract `useSessionLifecycle.ts` — session load, auto-resume, ACP recovery, idle timer, grace period
- [ ] Extract `message-utils.ts` — `groupMessages`, `chatMessagesToConversationItems`, `isPlaceholderContent`, `formatCountdown`
- [ ] Create `project-message-view/index.tsx` — main component, orchestration
- [ ] Delete original `ProjectMessageView.tsx`
- [ ] Update `ProjectChat.tsx` import to `../components/project-message-view`
- [ ] Verify no file exceeds 500 lines

### 3. Split ProjectChat.tsx → `pages/project-chat/` directory
- [ ] Create `pages/project-chat/` directory
- [ ] Extract `ChatSessionList.tsx` — desktop sidebar session list rendering
- [ ] Extract `MobileSessionDrawer.tsx` — mobile session drawer (already ~185 lines)
- [ ] Extract `SessionItem.tsx` — individual session list item
- [ ] Extract `ChatInput.tsx` — task submission form with agent/profile selection, attachments, voice
- [ ] Extract `ProvisioningIndicator.tsx` — provisioning progress bar
- [ ] Extract `useProjectSessions.ts` — session loading, filtering, search
- [ ] Extract `useProvisioningState.ts` — provisioning polling, state restoration
- [ ] Extract `useChatAttachments.ts` — file upload handling
- [ ] Create `project-chat/index.tsx` — main layout, session list + active session
- [ ] Delete original `ProjectChat.tsx`
- [ ] Update `App.tsx` import to `./pages/project-chat`
- [ ] Verify no file exceeds 500 lines

### 4. Validation
- [ ] Run `pnpm typecheck` — zero errors
- [ ] Run `pnpm lint` — zero errors
- [ ] Run `pnpm test` — all pass
- [ ] Run `pnpm build` — success
- [ ] Verify all files under 500 lines (excluding tests)

## Acceptance Criteria
- [ ] All three files are split into directories with focused sub-files
- [ ] No file exceeds 500 lines (excluding tests)
- [ ] All existing imports from other files continue to work via barrel exports
- [ ] React Router routes still work (page-level components at same import paths)
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all pass
- [ ] No behavioral changes — purely structural refactor

## References
- `.claude/rules/18-file-size-limits.md` — file size limits rule
- `apps/web/src/pages/Workspace.tsx`
- `apps/web/src/components/chat/ProjectMessageView.tsx`
- `apps/web/src/pages/ProjectChat.tsx`
