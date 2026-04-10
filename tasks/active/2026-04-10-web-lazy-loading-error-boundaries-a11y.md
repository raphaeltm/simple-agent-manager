# Web App: Lazy Loading, Error Boundaries, and Accessibility

## Problem Statement

The web app eagerly imports all page components, increasing initial bundle size. There are no granular error boundaries (only one global), so a crash in any component takes down the whole page. Several accessibility issues exist (missing aria-labels, missing button types). AuthProvider's context default makes it impossible to detect usage outside the provider. Terminal session IDs use `Math.random()` instead of `crypto.randomUUID()`.

## Research Findings

### Key Files
- `apps/web/src/App.tsx` — all 37 page imports are eager; single global `ErrorBoundary`
- `apps/web/src/components/ErrorBoundary.tsx` — class-based, global scope, reload/home recovery
- `apps/web/src/components/AuthProvider.tsx` — context default is a valid object (not null), so the null check in `useAuth()` never fires
- `apps/web/src/components/WorkspaceSidebar.tsx:236` — rename input missing `aria-label`
- `apps/web/src/components/project-message-view/FollowUpInput.tsx:66` — textarea missing `aria-label`
- `apps/web/src/components/MarkdownRenderer.tsx` — renders user/agent markdown, prone to parsing errors
- `packages/terminal/src/hooks/useTerminalSessions.ts:91-97` — manual UUID generation with `Math.random()`
- `packages/ui/src/components/Spinner.tsx` — existing Spinner component to use as lazy loading fallback

### Lazy Loading Targets
Priority (heavy/rarely visited):
- Admin pages (Admin, AdminAnalytics, AdminErrors, AdminLogs, AdminOverview, AdminStream, AdminUsers)
- AccountMap (imports ReactFlow)
- CreateWorkspace
- IdeaDetailPage
- ProjectSettings
- ProjectLibrary, ProjectActivity, ProjectNotifications, ProjectTriggers, ProjectTriggerDetail
- UiStandards
- Settings sub-pages
- Node/Nodes pages
- TaskDetail
- Workspace page

Keep eager (frequently visited):
- Dashboard, ProjectChat, Landing, Project (layout shell)

### Button Type Audit
62 buttons across 18 files missing `type="button"`. Key files: AccountMap, AdminUsers, Chats, IdeaDetailPage, IdeasPage, Node, ProjectLibrary, ProjectNotifications, ProjectSettings, ProjectTriggerDetail, ProjectTriggers, SettingsNotifications, TaskDetail, WorkspaceCreateMenu, WorkspaceHeader, WorkspaceStatus, workspace/index, PeriodSelector.

## Implementation Checklist

### 1. Route-level lazy loading
- [ ] Add `React.lazy()` imports for all non-core page components in `App.tsx`
- [ ] Wrap lazy-loaded route elements with `<Suspense fallback={<Spinner />}>`
- [ ] Keep Dashboard, ProjectChat, Landing, Project as eager imports

### 2. Granular ErrorBoundary component
- [ ] Create `RouteErrorBoundary` component with "Something went wrong" message and "Try again" button that resets the boundary
- [ ] Wrap each route-level component in App.tsx with `RouteErrorBoundary`
- [ ] Wrap `RenderedMarkdown` in `MarkdownRenderer.tsx` with the error boundary

### 3. Accessibility fixes
- [ ] Add `aria-label="Workspace name"` to rename input in WorkspaceSidebar.tsx
- [ ] Add `aria-label` to textarea in FollowUpInput.tsx
- [ ] Add `type="button"` to all non-submit buttons missing it across 18 files

### 4. AuthProvider context fix
- [ ] Change `createContext` default to `null` with type `AuthContextValue | null`
- [ ] Update `useAuth()` to properly detect null and throw helpful error

### 5. Replace Math.random() UUID
- [ ] Replace manual UUID generation in `useTerminalSessions.ts` with `crypto.randomUUID()`

### 6. Testing
- [ ] Write tests for `RouteErrorBoundary` component
- [ ] Test lazy-loaded routes render correctly
- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm build`

## Acceptance Criteria
- [ ] Heavy page components are lazy-loaded with code splitting
- [ ] Each route has a granular error boundary that can be reset without reloading
- [ ] MarkdownRenderer has an error boundary
- [ ] All interactive buttons have explicit `type="button"` attribute
- [ ] Workspace rename input and follow-up textarea have aria-labels
- [ ] AuthProvider context uses null default with runtime check
- [ ] Terminal session IDs use crypto.randomUUID()
- [ ] All existing tests pass
- [ ] Build produces separate chunks for lazy-loaded routes
- [ ] No breaking changes to existing behavior
