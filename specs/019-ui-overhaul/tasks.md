# Tasks: UI/UX Overhaul

**Input**: Design documents from `/specs/019-ui-overhaul/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Unit tests for all new primitives and key integration points (spec requires component tests per quality gates).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **UI primitives**: `packages/ui/src/components/`, `packages/ui/src/tokens/`, `packages/ui/src/hooks/`
- **Web app pages**: `apps/web/src/pages/`
- **Web app components**: `apps/web/src/components/`
- **Web app hooks**: `apps/web/src/hooks/`
- **Tests**: `packages/ui/tests/`, `apps/web/tests/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extend design token system with typography, color tints, shadows, and z-index tokens required by all subsequent phases.

- [x] T001 Add typography scale CSS custom properties (6 tiers: page-title, section-heading, card-title, body, secondary, caption) to `packages/ui/src/tokens/theme.css` per `contracts/typography.md`
- [x] T002 Add typography utility CSS classes (`.sam-type-page-title`, `.sam-type-section-heading`, `.sam-type-card-title`, `.sam-type-body`, `.sam-type-secondary`, `.sam-type-caption`) to `packages/ui/src/tokens/theme.css`
- [x] T003 [P] Add color tint tokens (`--sam-color-accent-primary-tint`, `--sam-color-success-tint`, `--sam-color-warning-tint`, `--sam-color-danger-tint`, `--sam-color-info-tint`) to `packages/ui/src/tokens/theme.css`
- [x] T004 [P] Add shadow tokens (`--sam-shadow-dropdown`, `--sam-shadow-overlay`, `--sam-shadow-tooltip`) to `packages/ui/src/tokens/theme.css`
- [x] T005 [P] Add z-index tokens (`--sam-z-sticky`, `--sam-z-dropdown`, `--sam-z-drawer-backdrop`, `--sam-z-drawer`, `--sam-z-dialog-backdrop`, `--sam-z-dialog`, `--sam-z-panel`, `--sam-z-command-palette`) to `packages/ui/src/tokens/theme.css`
- [x] T006 [P] Add section spacing token (`--sam-space-section: 2rem`) to `packages/ui/src/tokens/theme.css`
- [x] T007 Update TypeScript semantic token mappings in `packages/ui/src/tokens/semantic-tokens.ts` to include all new tokens (typography, tints, shadows, z-index)

**Checkpoint**: All design tokens available for primitive and page work. Verify by inspecting theme.css has all tokens from `contracts/typography.md` and `data-model.md` sections 1.1–1.4.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build shared hooks and the 6 missing UI primitives that navigation, entity lists, and page restructuring depend on.

**CRITICAL**: No user story work can begin until this phase is complete — US1 needs DropdownMenu, US2 needs DropdownMenu, US3 needs Tabs, etc.

### Shared Hooks

- [x] T008 [P] Create `useClickOutside` hook in `packages/ui/src/hooks/useClickOutside.ts` — attaches `mousedown` listener to document, calls callback when click is outside ref, respects `enabled` parameter
- [x] T009 [P] Create `useEscapeKey` hook in `packages/ui/src/hooks/useEscapeKey.ts` — attaches `keydown` listener to document for Escape key, respects `enabled` parameter

### Primitives

- [x] T010 [P] Create `DropdownMenu` component in `packages/ui/src/components/DropdownMenu.tsx` per `contracts/primitives.md` — trigger with MoreVertical icon, positioned menu, keyboard navigation (Arrow Up/Down, Enter, Escape), click-outside dismiss, `role="menu"` with roving tabindex, danger variant, disabled items with tooltip
- [x] T011 [P] Create `ButtonGroup` component in `packages/ui/src/components/ButtonGroup.tsx` per `contracts/primitives.md` — flex container, shared border radius (first/last child radii, middle radius 0), size prop passed to Button children, no gap with collapsed borders
- [x] T012 [P] Create `Tabs` component in `packages/ui/src/components/Tabs.tsx` per `contracts/primitives.md` — route-integrated with `NavLink`, `basePath` + `tab.path` construction, keyboard navigation (Arrow Left/Right, Home/End, Enter), `role="tablist"` with `aria-selected`, horizontal scroll snap for overflow, active tab underline with accent color
- [x] T013 [P] Create `Breadcrumb` component in `packages/ui/src/components/Breadcrumb.tsx` per `contracts/primitives.md` — `<nav aria-label="Breadcrumb">` with `<ol>`, `Link` segments with `/` separator, last segment as `<span aria-current="page">`, secondary font size
- [x] T014 [P] Create `Tooltip` component in `packages/ui/src/components/Tooltip.tsx` per `contracts/primitives.md` — delay-based show on mouseenter/focus, hide on mouseleave/blur/Escape, `role="tooltip"` with `aria-describedby`, positioned based on `side` prop, uses shadow and caption tokens
- [x] T015 [P] Create `EmptyState` component in `packages/ui/src/components/EmptyState.tsx` per `contracts/primitives.md` — centered flex column layout with 48x48 icon, section-heading heading, secondary description (max-width 320px), optional primary action button

### Exports & Tests

- [x] T016 Export all new hooks and components from `packages/ui/src/index.ts` — add exports for useClickOutside, useEscapeKey, DropdownMenu, ButtonGroup, Tabs, Breadcrumb, Tooltip, EmptyState
- [x] T017 [P] Write unit tests for `DropdownMenu` in `packages/ui/tests/DropdownMenu.test.tsx` — test open/close, keyboard navigation, click-outside dismiss, danger variant rendering, disabled items, aria attributes
- [x] T018 [P] Write unit tests for `ButtonGroup` in `packages/ui/tests/ButtonGroup.test.tsx` — test border radius application to first/last/middle children, size prop forwarding
- [x] T019 [P] Write unit tests for `Tabs` in `packages/ui/tests/Tabs.test.tsx` — test active tab detection from route, keyboard navigation, NavLink rendering with correct paths, aria attributes
- [x] T020 [P] Write unit tests for `Breadcrumb` in `packages/ui/tests/Breadcrumb.test.tsx` — test segment rendering, last segment non-clickable with aria-current, Link generation for path segments
- [x] T021 [P] Write unit tests for `Tooltip` in `packages/ui/tests/Tooltip.test.tsx` — test show/hide on hover with delay, Escape dismiss, focus trigger, aria-describedby linking
- [x] T022 [P] Write unit tests for `EmptyState` in `packages/ui/tests/EmptyState.test.tsx` — test heading/description rendering, optional icon, optional action button

**Checkpoint**: All 6 primitives render correctly, pass unit tests, use only design tokens (no hardcoded values). Verify exports work: `import { DropdownMenu, Tabs, ... } from '@simple-agent-manager/ui'`.

---

## Phase 3: User Story 1 — Persistent Navigation (Priority: P1) MVP

**Goal**: Users can navigate between Dashboard, Projects, Nodes, and Settings from any page in exactly 1 click.

**Independent Test**: Navigate from any page to all 4 main sections without intermediate pages. Test on both desktop (>= 768px) and mobile (< 768px) viewports.

### Implementation

- [x] T023 [US1] Create `AppShell` component in `apps/web/src/components/AppShell.tsx` per `contracts/navigation.md` — desktop: CSS grid with 220px sidebar + content area; mobile: single column with hamburger button. Sidebar nav items: Dashboard (Home icon, /dashboard), Projects (FolderKanban, /projects), Nodes (Server, /nodes), Settings (Settings, /settings). Active state via `useLocation().pathname.startsWith(item.path)`. User avatar + name + sign out at sidebar bottom.
- [x] T024 [US1] Create `NavSidebar` component in `apps/web/src/components/NavSidebar.tsx` — extract sidebar rendering from AppShell for reuse between desktop sidebar and mobile drawer. Nav items as application constants, active item styling with accent color background.
- [x] T025 [US1] Update `MobileNavDrawer` in `apps/web/src/components/MobileNavDrawer.tsx` — integrate with AppShell hamburger toggle, use NavSidebar for nav content, close drawer on route change via `useEffect` on `location.pathname`
- [x] T026 [US1] Update route structure in `apps/web/src/App.tsx` — wrap all protected routes (except `/workspaces/:id`) in `<AppShell><Outlet /></AppShell>` layout route per `contracts/navigation.md` route config
- [x] T027 [US1] Update `UserMenu` in `apps/web/src/components/UserMenu.tsx` — remove inline navigation links (Dashboard, Projects, Nodes, Settings) since navigation is now in the sidebar; keep user-specific actions (profile, sign out)
- [ ] T028 [US1] Add breadcrumb-style back link to `Workspace` page in `apps/web/src/pages/Workspace.tsx` — when persistent nav is hidden, provide a return path to the parent project using the Breadcrumb component

### Tests

- [x] T029 [P] [US1] Write unit test for `AppShell` in `apps/web/tests/unit/AppShell.test.tsx` — test desktop sidebar visibility, mobile hamburger rendering, active nav item highlighting, route wrapping

**Checkpoint**: User Story 1 complete. From any page, clicking a nav link navigates directly to that section. Mobile drawer works. Workspace page has no sidebar but has a back link.

---

## Phase 4: User Story 2 — Scannable Entity Lists (Priority: P1)

**Goal**: Workspace and node lists show compact entries with 1 visible primary action and an overflow menu for secondary actions.

**Independent Test**: View workspace and node lists; verify each entry shows only primary action visibly, overflow menu reveals all valid state-dependent actions.

### Implementation

- [x] T030 [US2] Create `getWorkspaceActions` helper in `apps/web/src/components/WorkspaceCard.tsx` (or extracted utility) — returns `DropdownMenuItem[]` based on workspace status per `data-model.md` section 4.4. Running: show Stop, Delete. Stopped: show Start, Delete. Transitional states: disable actions with `disabledReason`.
- [x] T031 [US2] Refactor `WorkspaceCard` in `apps/web/src/components/WorkspaceCard.tsx` — replace inline action buttons with: one visible primary action button ("Open" for running, "Start" for stopped) + `DropdownMenu` with overflow actions. Compact layout: status indicator, name, repository, branch, last active time in a single row.
- [x] T032 [US2] Create `getNodeActions` helper for node list entries — returns `DropdownMenuItem[]` based on node status (Stop, Delete, with state-dependent disabling)
- [x] T033 [US2] Refactor node list entries in `apps/web/src/pages/Nodes.tsx` — replace inline action buttons with primary action + `DropdownMenu`. Show status, name, workspace count. Move system metrics (CPU, memory, disk) to node detail page only.
- [x] T034 [US2] Update `ProjectSummaryCard` in `apps/web/src/components/ProjectSummaryCard.tsx` — compact layout with overflow menu for project-level actions (Edit, Delete)

### Tests

- [x] T035 [P] [US2] Write unit test for `WorkspaceCard` overflow menu in `apps/web/tests/unit/WorkspaceCard.test.tsx` — test that only primary action is visible, overflow menu shows correct state-dependent actions, disabled actions show reason

**Checkpoint**: User Story 2 complete. Entity lists are scannable with reduced visual noise. Primary action visible, secondary actions in overflow menu.

---

## Phase 5: User Story 3 — Project Detail Sub-Routes (Priority: P2)

**Goal**: Project detail organized into 5 routed sub-sections (Overview, Tasks, Sessions, Settings, Activity) with unique URLs.

**Independent Test**: Navigate to each project sub-route directly by URL (e.g., `/projects/:id/tasks`), verify content renders correctly, browser refresh preserves active tab.

**Dependencies**: Requires Tabs component from Phase 2 (T012).

### Implementation

- [x] T036 [US3] Refactor `Project.tsx` in `apps/web/src/pages/Project.tsx` — convert from monolithic page to shell component: project header + Breadcrumb + `Tabs` (Overview, Tasks, Sessions, Settings, Activity) + `<Outlet />`. Remove all section content (moved to sub-route pages).
- [x] T037 [P] [US3] Create `ProjectOverview.tsx` in `apps/web/src/pages/ProjectOverview.tsx` — extract summary stats and project edit form from current `Project.tsx`. Display project description, workspace count, recent activity summary.
- [x] T038 [P] [US3] Create `ProjectTasks.tsx` in `apps/web/src/pages/ProjectTasks.tsx` — extract task list, task filters, and task creation from current `Project.tsx`. Use existing `TaskList`, `TaskFilters`, `TaskForm` components from `apps/web/src/components/project/`.
- [x] T039 [P] [US3] Create `ProjectSessions.tsx` in `apps/web/src/pages/ProjectSessions.tsx` — extract chat session list from current `Project.tsx`. Use existing `ChatSessionList` component.
- [x] T040 [P] [US3] Create `ProjectSettings.tsx` in `apps/web/src/pages/ProjectSettings.tsx` — extract runtime configuration (env vars, files) from current `Project.tsx`. Provide adequate spacing for editing experience.
- [x] T041 [P] [US3] Create `ProjectActivity.tsx` in `apps/web/src/pages/ProjectActivity.tsx` — extract activity feed from current `Project.tsx`. Use existing `ActivityFeed` component.
- [x] T042 [US3] Update route structure in `apps/web/src/App.tsx` — add nested routes under `/projects/:id` with child routes: `overview` (index redirect), `tasks`, `tasks/:taskId`, `sessions`, `sessions/:sessionId`, `settings`, `activity` per `contracts/navigation.md`
- [x] T043 [US3] Update `TaskDetail.tsx` in `apps/web/src/pages/TaskDetail.tsx` — ensure it works as a nested route under `/projects/:id/tasks/:taskId` and includes Breadcrumb (Dashboard > Projects > Project Name > Tasks > Task Title)
- [x] T044 [US3] Update `ChatSessionView.tsx` in `apps/web/src/pages/ChatSessionView.tsx` — ensure it works as a nested route under `/projects/:id/sessions/:sessionId` and includes Breadcrumb

### Tests

- [x] T045 [P] [US3] Write unit test for Project shell in `apps/web/tests/unit/Project.test.tsx` — test that Tabs render with correct labels/paths, Outlet renders child content, Breadcrumb shows project name

**Checkpoint**: User Story 3 complete. Each project sub-section has its own URL, loads independently, and persists across refresh.

---

## Phase 6: User Story 4 — Complete UI Primitives (Priority: P2)

**Goal**: All 6 primitives are available, documented, and visible on the UiStandards page.

**Independent Test**: Render each primitive in isolation with all documented prop variants; verify design token usage and accessibility attributes.

**Note**: The actual primitive *implementation* is in Phase 2 (Foundational). This phase covers integration into the app's standards page and any remaining integration polish.

### Implementation

- [x] T046 [US4] Add DropdownMenu examples to `apps/web/src/pages/UiStandards.tsx` — show default trigger, custom trigger, danger items, disabled items with reasons, start/end alignment
- [x] T047 [P] [US4] Add ButtonGroup examples to `apps/web/src/pages/UiStandards.tsx` — show 2-button and 3-button groups with size variants
- [x] T048 [P] [US4] Add Tabs examples to `apps/web/src/pages/UiStandards.tsx` — show route-integrated tabs with active state
- [x] T049 [P] [US4] Add Breadcrumb, Tooltip, and EmptyState examples to `apps/web/src/pages/UiStandards.tsx` — show all prop variants for each
- [x] T050 [US4] Update `packages/ui/src/primitives/Typography.tsx` — extend with named typography tier components (PageTitle, SectionHeading, CardTitle, Body, Secondary, Caption) that apply the corresponding CSS class from the typography scale

### Tests

- [x] T051 [P] [US4] Write unit test for Typography tier components in `packages/ui/tests/Typography.test.tsx` — test each tier renders with correct CSS class

**Checkpoint**: User Story 4 complete. All primitives documented on UiStandards page, Typography component extended with named tiers.

---

## Phase 7: User Story 5 — Consistent Typography & Visual Hierarchy (Priority: P2)

**Goal**: All pages use standardized typography tokens; zero inline fontSize declarations remain.

**Independent Test**: Run `grep -r "fontSize:" apps/web/src/` and confirm zero results in component/page files. Audit all pages for visual hierarchy consistency.

**Dependencies**: Requires typography tokens from Phase 1 (T001–T002) and Typography components from Phase 6 (T050).

### Implementation

- [x] T052 [US5] Migrate typography in `apps/web/src/pages/Dashboard.tsx` — replace all inline fontSize/fontWeight with typography CSS classes or Typography components
- [x] T053 [P] [US5] Migrate typography in `apps/web/src/pages/Projects.tsx` — replace all inline fontSize/fontWeight
- [x] T054 [P] [US5] Migrate typography in `apps/web/src/pages/Nodes.tsx` — replace all inline fontSize/fontWeight
- [x] T055 [P] [US5] Migrate typography in `apps/web/src/pages/Settings.tsx` — replace all inline fontSize/fontWeight
- [x] T056 [P] [US5] Migrate typography in `apps/web/src/pages/Node.tsx` — replace all inline fontSize/fontWeight
- [x] T057 [P] [US5] Migrate typography in `apps/web/src/pages/CreateWorkspace.tsx` — replace all inline fontSize/fontWeight
- [x] T058 [P] [US5] Migrate typography in `apps/web/src/pages/TaskDetail.tsx` — replace all inline fontSize/fontWeight (worst offender: 30+ issues)
- [x] T059 [P] [US5] Migrate typography in `apps/web/src/pages/Workspace.tsx` — replace all inline fontSize/fontWeight (24+ issues)
- [x] T060 [P] [US5] Migrate typography in `apps/web/src/components/WorkspaceCard.tsx` — replace all inline fontSize/fontWeight (24+ issues)
- [x] T061 [P] [US5] Migrate typography in `apps/web/src/components/WorkspaceSidebar.tsx` — replace all inline fontSize/fontWeight (30+ issues)
- [x] T062 [P] [US5] Migrate typography in `apps/web/src/components/WorkspaceTabStrip.tsx` — replace all inline fontSize/fontWeight (32+ issues)
- [x] T063 [P] [US5] Migrate typography in remaining `apps/web/src/components/` files — batch migrate all other components with inline fontSize (ActivityFeed, AgentKeyCard, ChatSession, ChatSessionList, CollapsibleSection, CommandPalette, ConfirmDialog, CredentialToggle, HetznerTokenForm, GitHubAppSection, etc.)
- [x] T064 [P] [US5] Migrate typography in `apps/web/src/components/node/` subdirectory — replace all inline fontSize/fontWeight in NodeOverviewSection, SystemResourcesSection, DockerSection, SoftwareSection, NodeEventsSection, etc.
- [x] T065 [P] [US5] Migrate typography in `apps/web/src/components/project/` subdirectory — replace all inline fontSize/fontWeight in ProjectForm, TaskForm, TaskList, TaskFilters, TaskDependencyEditor, etc.

**Checkpoint**: User Story 5 complete. `grep -r "fontSize:" apps/web/src/` returns zero results. All text follows the 6-tier hierarchy.

---

## Phase 8: User Story 6 — Settings Sub-Routes (Priority: P3)

**Goal**: Settings organized into 4 routed sub-sections with unique, shareable URLs.

**Independent Test**: Navigate directly to `/settings/agent-keys` and confirm only that section renders. Browser refresh preserves active tab.

**Dependencies**: Requires Tabs component from Phase 2 (T012) and AppShell from Phase 3 (T023).

### Implementation

- [x] T066 [US6] Refactor `Settings.tsx` in `apps/web/src/pages/Settings.tsx` — convert to shell component: page header + Breadcrumb + `Tabs` (Cloud Provider, GitHub, Agent Keys, Agent Configuration) + `<Outlet />`. Remove all section content (moved to sub-route pages).
- [x] T067 [P] [US6] Create `SettingsCloudProvider.tsx` in `apps/web/src/pages/SettingsCloudProvider.tsx` — extract Hetzner token form from current `Settings.tsx`. Use existing `HetznerTokenForm` component.
- [x] T068 [P] [US6] Create `SettingsGitHub.tsx` in `apps/web/src/pages/SettingsGitHub.tsx` — extract GitHub App section from current `Settings.tsx`. Use existing `GitHubAppSection` component.
- [x] T069 [P] [US6] Create `SettingsAgentKeys.tsx` in `apps/web/src/pages/SettingsAgentKeys.tsx` — extract agent keys section from current `Settings.tsx`. Use existing `AgentKeysSection` component.
- [x] T070 [P] [US6] Create `SettingsAgentConfig.tsx` in `apps/web/src/pages/SettingsAgentConfig.tsx` — extract agent settings section from current `Settings.tsx`. Use existing `AgentSettingsSection` component.
- [x] T071 [US6] Update route structure in `apps/web/src/App.tsx` — add nested routes under `/settings` with child routes: `cloud-provider` (index redirect), `github`, `agent-keys`, `agent-config`

### Tests

- [x] T072 [P] [US6] Write unit test for Settings shell in `apps/web/tests/unit/Settings.test.tsx` — test that Tabs render with correct labels/paths, Outlet renders child content

**Checkpoint**: User Story 6 complete. Each settings section has its own URL, loads independently.

---

## Phase 9: User Story 7 — Dedicated Creation Forms (Priority: P3)

**Goal**: Project and task creation use dedicated routes/modals instead of inline toggle forms.

**Independent Test**: Click "New Project" and confirm it opens a dedicated route (`/projects/new`) or modal, not an inline form. Same for task creation.

### Implementation

- [x] T073 [US7] Create `ProjectCreate.tsx` in `apps/web/src/pages/ProjectCreate.tsx` — dedicated route page for project creation. Use existing `ProjectForm` component from `apps/web/src/components/project/ProjectForm.tsx`. On success, redirect to new project's detail page. Include Breadcrumb (Dashboard > Projects > New Project).
- [x] T074 [US7] Update `Projects.tsx` in `apps/web/src/pages/Projects.tsx` — replace inline project creation form toggle with a "New Project" button that navigates to `/projects/new`
- [x] T075 [US7] Update task creation in `apps/web/src/pages/ProjectTasks.tsx` — replace inline task creation form with a modal or slide-over panel using `Dialog` component. "New Task" button opens the dialog with `TaskForm` inside.
- [x] T076 [US7] Add `/projects/new` route to `apps/web/src/App.tsx` if not already added in T042

**Checkpoint**: User Story 7 complete. Creation flows are focused, URL-addressable (projects) or modal-based (tasks).

---

## Phase 10: User Story 8 — Project-First Dashboard (Priority: P3)

**Goal**: Dashboard leads with projects and their grouped workspaces, aligning with project-first architecture.

**Independent Test**: Log in and confirm dashboard shows projects prominently with associated workspaces grouped under each project. Orphaned workspaces shown separately.

### Implementation

- [x] T077 [US8] Redesign `Dashboard.tsx` in `apps/web/src/pages/Dashboard.tsx` — replace current layout with project-first design: list projects as primary content with `ProjectSummaryCard` showing each project's active workspaces grouped underneath. Remove quick-action navigation buttons (persistent nav replaces them).
- [x] T078 [US8] Add "Unlinked Workspaces" section to `apps/web/src/pages/Dashboard.tsx` — display workspaces not linked to any project in a separate section with suggestion to link them
- [x] T079 [US8] Add `EmptyState` to `apps/web/src/pages/Dashboard.tsx` — when user has no projects, show EmptyState with "Create your first project" action

**Checkpoint**: User Story 8 complete. Dashboard is project-centric with grouped workspaces.

---

## Phase 11: User Story 9 — Guided Onboarding (Priority: P3)

**Goal**: New users see a checklist tracking setup progress (Hetzner token, GitHub App, first workspace).

**Independent Test**: Create/simulate a new user without completed setup; confirm checklist appears, updates as steps complete, and dismisses permanently once done.

### Implementation

- [x] T080 [US9] Create `OnboardingChecklist` component in `apps/web/src/components/OnboardingChecklist.tsx` — derive state from existing API data per `data-model.md` section 4.3: `hasHetznerToken` (settings API), `hasGitHubApp` (settings API), `hasWorkspace` (workspaces list length > 0). Dismissed state in `localStorage('sam-onboarding-dismissed-${userId}')`. Show checklist card with 3 steps, progress indicator, links to relevant setup pages.
- [x] T081 [US9] Integrate `OnboardingChecklist` into `apps/web/src/pages/Dashboard.tsx` — show at top of dashboard when `!dismissed && (!hasHetznerToken || !hasGitHubApp || !hasWorkspace)`. Hide when all steps complete or dismissed.
- [x] T082 [US9] Add `EmptyState` components to all list pages — `apps/web/src/pages/Projects.tsx` (no projects), `apps/web/src/pages/Nodes.tsx` (no nodes), `apps/web/src/pages/ProjectTasks.tsx` (no tasks), `apps/web/src/pages/ProjectSessions.tsx` (no sessions)

### Tests

- [x] T083 [P] [US9] Write unit test for `OnboardingChecklist` in `apps/web/tests/unit/OnboardingChecklist.test.tsx` — test visibility logic (show when setup incomplete, hide when complete), dismiss persistence, step completion display

**Checkpoint**: User Story 9 complete. New users get guided setup experience.

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: Inline style remediation, hardcoded value cleanup, and final audit across all pages.

### Hover Handler Remediation (Tier 1 from research.md R6)

- [ ] T084 [P] Replace all `onMouseEnter`/`onMouseLeave` hover handlers with CSS `:hover` classes across `apps/web/src/components/` — audit and replace ~35 instances per research.md R6

### Hardcoded Color Remediation (Tier 2–3 from research.md R6)

- [ ] T085 [P] Replace all hardcoded hex color values (`#xxx`) with `--sam-color-*` design tokens across `apps/web/src/` — ~118 instances per research.md R6
- [ ] T086 [P] Replace all hardcoded `rgba()` values with `--sam-color-*-tint` or `--sam-shadow-*` tokens across `apps/web/src/` — ~118 instances per research.md R6

### Border & Spacing Pattern Remediation (Tier 5 from research.md R6)

- [ ] T087 [P] Replace repeated inline border/borderRadius/padding patterns with shared component usage or CSS classes across `apps/web/src/` — ~89 instances per research.md R6

### Z-Index Consolidation

- [ ] T088 Update existing overlay components to use z-index tokens — update `CommandPalette.tsx`, `Dialog.tsx`, `MobileNavDrawer.tsx`, `FileBrowserPanel.tsx`, `GitChangesPanel.tsx`, `FileViewerPanel.tsx` in `apps/web/src/components/` to use `var(--sam-z-*)` tokens instead of hardcoded z-index values

### Final Validation

- [ ] T089 Run full lint, typecheck, and test suite — `pnpm lint && pnpm typecheck && pnpm test`
- [ ] T090 Validate zero inline fontSize declarations: `grep -r "fontSize:" apps/web/src/` returns zero results in component/page TSX files
- [ ] T091 Validate zero hardcoded hex colors: `grep -rP "#[0-9a-fA-F]{3,8}" apps/web/src/components/ apps/web/src/pages/` returns zero results in TSX files
- [ ] T092 Validate zero hover handlers: `grep -r "onMouseEnter" apps/web/src/` returns zero results
- [ ] T093 Run `quickstart.md` validation — verify development workflow, test commands, and testing checklist items all pass
- [ ] T094 Update `apps/web/src/pages/UiStandards.tsx` with final primitive inventory and usage guidelines

**Checkpoint**: All success criteria from spec.md (SC-001 through SC-008) verified.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 token completion — BLOCKS all user stories
- **US1 Navigation (Phase 3)**: Depends on Phase 2 (uses DropdownMenu pattern knowledge, layout primitives)
- **US2 Entity Lists (Phase 4)**: Depends on Phase 2 (uses DropdownMenu)
- **US3 Project Sub-Routes (Phase 5)**: Depends on Phase 2 (uses Tabs, Breadcrumb)
- **US4 Primitive Standards (Phase 6)**: Depends on Phase 2 (primitives must exist to document)
- **US5 Typography (Phase 7)**: Depends on Phase 1 (tokens) + Phase 6 T050 (Typography components)
- **US6 Settings Sub-Routes (Phase 8)**: Depends on Phase 2 (uses Tabs) + Phase 3 (needs AppShell)
- **US7 Creation Forms (Phase 9)**: Depends on Phase 5 (project sub-routes) + Phase 3 (navigation)
- **US8 Dashboard (Phase 10)**: Depends on Phase 3 (persistent nav replaces quick-actions) + Phase 4 (compact cards)
- **US9 Onboarding (Phase 11)**: Depends on Phase 10 (dashboard must be project-first first)
- **Polish (Phase 12)**: Depends on all user stories being complete

### User Story Independence

| Story | Can Start After | Independent of |
|-------|----------------|----------------|
| US1 (Nav) | Phase 2 | US2, US3, US4, US5, US6, US7, US8, US9 |
| US2 (Lists) | Phase 2 | US1, US3, US4, US5, US6, US7, US8, US9 |
| US3 (Project Routes) | Phase 2 | US1, US2, US4, US5, US6 |
| US4 (Primitives Docs) | Phase 2 | US1, US2, US3, US5, US6, US7, US8, US9 |
| US5 (Typography) | Phase 1 + T050 | US1, US2, US3, US6, US7, US8, US9 |
| US6 (Settings Routes) | Phase 2 + US1 | US2, US3, US4, US5, US7, US8, US9 |
| US7 (Creation Forms) | US3 + US1 | US2, US4, US5, US6, US8, US9 |
| US8 (Dashboard) | US1 + US2 | US3, US4, US5, US6, US9 |
| US9 (Onboarding) | US8 | US3, US4, US5, US6, US7 |

### Within Each User Story

- Models/helpers before UI components
- Shell components before sub-route pages
- Route updates after all pages exist
- Tests can run in parallel with each other

### Parallel Opportunities

**After Phase 2 completes, these can all start in parallel:**
- US1 (Navigation) — different files from US2/US3/US4
- US2 (Entity Lists) — different files from US1/US3/US4
- US3 (Project Sub-Routes) — different files from US1/US2/US4
- US4 (Primitive Docs) — only touches UiStandards.tsx
- US5 (Typography) — different files from US1/US2/US3/US4

**Within each phase, [P] tasks can run in parallel.**

---

## Parallel Example: Phase 2 (Foundational)

```bash
# Launch all hooks in parallel:
Task: "Create useClickOutside hook in packages/ui/src/hooks/useClickOutside.ts"
Task: "Create useEscapeKey hook in packages/ui/src/hooks/useEscapeKey.ts"

# Launch all 6 primitives in parallel (different files, no deps between them):
Task: "Create DropdownMenu in packages/ui/src/components/DropdownMenu.tsx"
Task: "Create ButtonGroup in packages/ui/src/components/ButtonGroup.tsx"
Task: "Create Tabs in packages/ui/src/components/Tabs.tsx"
Task: "Create Breadcrumb in packages/ui/src/components/Breadcrumb.tsx"
Task: "Create Tooltip in packages/ui/src/components/Tooltip.tsx"
Task: "Create EmptyState in packages/ui/src/components/EmptyState.tsx"

# After primitives complete, launch all tests in parallel:
Task: "Test DropdownMenu"
Task: "Test ButtonGroup"
Task: "Test Tabs"
Task: "Test Breadcrumb"
Task: "Test Tooltip"
Task: "Test EmptyState"
```

## Parallel Example: User Story 5 (Typography Migration)

```bash
# All page migrations can run in parallel (different files):
Task: "Migrate typography in Dashboard.tsx"
Task: "Migrate typography in Projects.tsx"
Task: "Migrate typography in Nodes.tsx"
Task: "Migrate typography in Settings.tsx"
Task: "Migrate typography in Node.tsx"
Task: "Migrate typography in TaskDetail.tsx"
Task: "Migrate typography in Workspace.tsx"
Task: "Migrate typography in WorkspaceCard.tsx"
# ... etc
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Design Token Setup
2. Complete Phase 2: Foundational Primitives + Hooks
3. Complete Phase 3: User Story 1 (Persistent Navigation)
4. Complete Phase 4: User Story 2 (Scannable Entity Lists)
5. **STOP and VALIDATE**: Test navigation from any page, verify compact entity lists
6. Deploy/demo if ready — this delivers the two highest-impact improvements

### Incremental Delivery

1. Phases 1–2 → Foundation ready
2. Add US1 + US2 → Test → Deploy (**MVP!** — persistent nav + clean lists)
3. Add US3 → Test → Deploy (project sub-routes)
4. Add US5 → Test → Deploy (typography consistency — can run in parallel with US3)
5. Add US6 + US7 → Test → Deploy (settings routes + creation forms)
6. Add US8 + US9 → Test → Deploy (dashboard + onboarding)
7. Phase 12 → Polish → Final deploy

---

## Notes

- [P] tasks = different files, no dependencies between them
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable (after Phase 2)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The spec explicitly requires tests for new primitives (quality gates rule 02)
- Constitution Principle XI: every token value must use CSS custom properties, no hardcoded px/rem in component code
