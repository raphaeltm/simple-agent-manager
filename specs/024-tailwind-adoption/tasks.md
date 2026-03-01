# Tasks: Tailwind CSS Adoption

**Input**: Design documents from `/specs/024-tailwind-adoption/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/token-mapping.md, quickstart.md

**Tests**: Not explicitly requested in the spec. Visual regression verification tasks are included where critical.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install Tailwind CSS v4, configure the Vite plugin, create the `@theme` token mapping, and prepare the codebase for incremental migration.

- [x] T001 Install `tailwindcss` and `@tailwindcss/vite` in `apps/web/package.json` and add `tailwindcss` as peer dependency in `packages/ui/package.json`, then run `pnpm install`
- [x] T002 Add `@tailwindcss/vite` plugin to `apps/web/vite.config.ts` (add `import tailwindcss from '@tailwindcss/vite'` and add `tailwindcss()` to plugins array)
- [x] T003 Add shadow scale CSS variables (`--sam-shadow-sm`, `--sam-shadow-default`, `--sam-shadow-md`, `--sam-shadow-lg`, `--sam-shadow-xl`) to `packages/ui/src/tokens/theme.css` with the dark-tuned values currently hardcoded in `apps/web/src/index.css` (Constitution Principle XI compliance)
- [x] T004 Create `apps/web/src/app.css` with `@import "tailwindcss"` and the full `@theme` block mapping all SAM tokens per `specs/024-tailwind-adoption/research.md` Decision 2 (colors, tints, semantic fg colors, Tokyo Night palette, shadows, radii, z-index)
- [x] T005 Add `@custom-variant dark` directive to `apps/web/src/app.css` for future light mode support per research.md Decision 7
- [x] T006 Import `app.css` in `apps/web/src/main.tsx` (before `index.css` to establish correct cascade order)
- [x] T007 Verify the build succeeds with `pnpm --filter @simple-agent-manager/web build` and confirm Tailwind utility classes are generated in the output CSS
- [ ] T007a Capture baseline Playwright screenshots of key pages (Dashboard, Project, Workspace, Settings, Admin) before any visual migration begins — store in `.codex/tmp/playwright-screenshots/baseline/` for SC-004 comparison

**Checkpoint**: Tailwind CSS is installed and configured. Utility classes are available. Baseline screenshots captured. No visual changes yet — existing inline styles still take precedence.

---

## Phase 2: Foundational (index.css Cleanup)

**Purpose**: Remove hand-rolled utility classes from `index.css` that Tailwind now provides. Resolve naming conflicts. This MUST complete before component migration begins.

- [x] T008 Remove 153 exact-match Tailwind utility classes from `apps/web/src/index.css` per research.md Decision 3 (typography, layout, spacing, sizing, borders, positioning, overflow, animations, opacity classes)
- [x] T009 Remove 16 SAM-specific semantic utility classes from `apps/web/src/index.css` that are now covered by `@theme` mappings (bg-canvas, bg-surface, bg-inset, text-primary, text-muted, text-accent, border-default, hover variants, etc.)
- [x] T010 Keep form element reset styles, CSS reset block, and `min-h-screen` custom utility in `apps/web/src/index.css` (these are not replaced by Tailwind)
- [x] T011 Extract keyframe animations from `packages/ui/src/components/Skeleton.tsx` and `packages/ui/src/components/Toast.tsx` (runtime `document.createElement('style')` injections) into `packages/ui/src/styles.css` as static `@keyframes` rules, and remove the runtime injection code
- [x] T012 [P] Extract keyframe animations from `apps/web/src/components/MobileNavDrawer.tsx` (`sam-drawer-slide-in`, `sam-drawer-fade-in`) into `apps/web/src/app.css`
- [x] T013 [P] Extract keyframe animations from `apps/web/src/pages/ProjectChat.tsx` (`sam-session-drawer-slide-in`, `sam-session-drawer-fade-in`) into `apps/web/src/app.css`
- [x] T014 [P] Extract spin keyframe from `apps/web/src/components/GitChangesPanel.tsx` (duplicate of existing `sam-spin`) — remove the inline `<style>` and use the existing animation class
- [x] T015 Verify build and run `pnpm --filter @simple-agent-manager/web build` to confirm no regressions from index.css cleanup

**Checkpoint**: Foundation ready. All hand-rolled utilities removed, keyframe animations extracted to static CSS. Component migration can now begin.

---

## Phase 3: User Story 4 - UI Package Components Use Utility Classes (Priority: P3, but executed first as foundation)

**Goal**: Migrate all 19 styled UI package components (16 components + 3 primitives) from inline `CSSProperties` to Tailwind utility classes. This establishes the migration pattern before tackling the larger web app.

**Independent Test**: All UI components render identically. Run existing tests and visually verify Button, Dialog, Card, Alert, and DropdownMenu in the app.

### Batch 1: Simple components (1 inline style each)

- [x] T016 [P] [US4] Migrate `packages/ui/src/components/StatusBadge.tsx` — replace inline styles with Tailwind classes
- [x] T017 [P] [US4] Migrate `packages/ui/src/components/Spinner.tsx` — replace inline styles with Tailwind classes
- [x] T018 [P] [US4] Migrate `packages/ui/src/components/Input.tsx` — replace inline styles with Tailwind classes
- [x] T019 [P] [US4] Migrate `packages/ui/src/components/Select.tsx` — replace inline styles with Tailwind classes

### Batch 2: Medium components (1-3 inline styles)

- [x] T020 [P] [US4] Migrate `packages/ui/src/components/Card.tsx` — replace inline styles with Tailwind classes
- [x] T021 [P] [US4] Migrate `packages/ui/src/components/ButtonGroup.tsx` — replace inline styles with Tailwind classes
- [x] T022 [P] [US4] Migrate `packages/ui/src/components/Tooltip.tsx` — replace inline styles with Tailwind classes
- [x] T023 [P] [US4] Migrate `packages/ui/src/components/Skeleton.tsx` — replace inline styles with Tailwind classes (runtime injection already removed in T011)

### Batch 3: Complex components (4+ inline styles)

- [x] T024 [P] [US4] Migrate `packages/ui/src/components/Alert.tsx` — replace 4 inline style objects with Tailwind classes for all 4 variants (error, warning, success, info)
- [x] T025 [P] [US4] Migrate `packages/ui/src/components/Button.tsx` — replace inline styles with Tailwind classes for all 4 variants (primary, secondary, danger, ghost) x 3 sizes (sm, md, lg) + loading state
- [x] T026 [P] [US4] Migrate `packages/ui/src/components/Breadcrumb.tsx` — replace inline styles + remove `<style>` hover injection, use `hover:` Tailwind variant
- [x] T027 [P] [US4] Migrate `packages/ui/src/components/Tabs.tsx` — replace inline styles + remove `<style>` hover/focus injection, use Tailwind variants

### Batch 4: Most complex components (5-6 inline styles + injection)

- [x] T028 [US4] Migrate `packages/ui/src/components/Dialog.tsx` — replace 5 inline style objects with Tailwind classes, preserve keyboard navigation and focus trapping
- [x] T029 [US4] Migrate `packages/ui/src/components/DropdownMenu.tsx` — replace 6 inline style objects + remove `<style>` hover injection, use Tailwind variants, preserve keyboard navigation
- [x] T030 [US4] Migrate `packages/ui/src/components/Toast.tsx` — replace 6 inline style objects with Tailwind classes (runtime injection already removed in T011)
- [x] T031 [US4] Migrate `packages/ui/src/components/EmptyState.tsx` — replace 5 inline style objects with Tailwind classes

### Batch 5: Primitives

- [x] T031a [P] [US4] Migrate `packages/ui/src/primitives/Typography.tsx` — replace inline styles with Tailwind classes
- [x] T031b [P] [US4] Migrate `packages/ui/src/primitives/Container.tsx` — replace inline styles with Tailwind classes
- [x] T031c [P] [US4] Migrate `packages/ui/src/primitives/PageLayout.tsx` — replace inline styles with Tailwind classes
- [x] T032 [US4] Build UI package with `pnpm --filter @simple-agent-manager/ui build` and web app with `pnpm --filter @simple-agent-manager/web build` to verify no regressions

**Checkpoint**: All 19 styled UI package components migrated (16 components + 3 primitives). Zero inline `CSSProperties` in `packages/ui`. SC-001 and SC-007 achieved.

---

## Phase 4: User Story 1 - Consistent Styling Across All Pages (Priority: P1) — Web App Core Components

**Goal**: Migrate the core web app components (layout, navigation, shared UI) from inline styles to Tailwind utility classes.

**Independent Test**: Navigate through the app — AppShell, NavSidebar, and shared components render correctly with no visual regressions.

### Layout & Navigation

- [ ] T033 [P] [US1] Migrate `apps/web/src/components/AppShell.tsx` — replace inline styles + remove `<style>` hover injection for sign-out button
- [ ] T034 [P] [US1] Migrate `apps/web/src/components/NavSidebar.tsx` — replace inline styles with Tailwind classes
- [ ] T035 [P] [US1] Migrate `apps/web/src/components/MobileNavDrawer.tsx` — replace inline styles, remove `<style>` block (keyframes extracted in T012), use Tailwind for hover/active states
- [ ] T036 [P] [US1] Migrate `apps/web/src/components/UserMenu.tsx` — replace inline styles with Tailwind classes
- [ ] T037 [P] [US1] Migrate `apps/web/src/components/CommandPalette.tsx` — replace inline styles with Tailwind classes
- [ ] T038 [P] [US1] Migrate `apps/web/src/components/CommandPaletteButton.tsx` — replace inline styles with Tailwind classes

### Shared Components

- [ ] T039 [P] [US1] Migrate `apps/web/src/components/ConfirmDialog.tsx` — replace inline styles with Tailwind classes
- [ ] T040 [P] [US1] Migrate `apps/web/src/components/StatusBadge.tsx` — replace inline styles with Tailwind classes
- [ ] T041 [P] [US1] Migrate `apps/web/src/components/CollapsibleSection.tsx` — replace inline styles with Tailwind classes
- [ ] T042 [P] [US1] Migrate `apps/web/src/components/ErrorBoundary.tsx` — replace inline styles with Tailwind classes
- [ ] T043 [P] [US1] Migrate `apps/web/src/components/MarkdownRenderer.tsx` — replace inline styles with Tailwind classes
- [ ] T044 [P] [US1] Migrate `apps/web/src/components/KeyboardShortcutsHelp.tsx` — replace inline styles with Tailwind classes
- [ ] T045 [P] [US1] Migrate `apps/web/src/components/OrphanedSessionsBanner.tsx` — replace inline styles with Tailwind classes
- [ ] T046 [P] [US1] Migrate `apps/web/src/components/OnboardingChecklist.tsx` — replace inline styles with Tailwind classes

### Auth

- [ ] T047 [P] [US1] Migrate `apps/web/src/components/AuthProvider.tsx` and `apps/web/src/components/ProtectedRoute.tsx` — replace inline styles with Tailwind classes
- [ ] T048 [P] [US1] Migrate `apps/web/src/components/AuthInstructions.tsx` — replace inline styles with Tailwind classes
- [ ] T049 [P] [US1] Migrate `apps/web/src/components/CredentialToggle.tsx` — replace inline styles with Tailwind classes

### Pages: Simple

- [ ] T050 [P] [US1] Migrate `apps/web/src/pages/Landing.tsx` — replace inline styles, remove `<style>` responsive grid injection, use Tailwind breakpoints
- [ ] T051 [P] [US1] Migrate `apps/web/src/pages/PendingApproval.tsx` — replace inline styles with Tailwind classes
- [ ] T052 [P] [US1] Migrate `apps/web/src/pages/Settings.tsx` and `apps/web/src/pages/SettingsContext.tsx` — replace inline styles with Tailwind classes
- [ ] T053 [P] [US1] Migrate `apps/web/src/pages/SettingsCloudProvider.tsx` — replace inline styles with Tailwind classes
- [ ] T054 [P] [US1] Migrate `apps/web/src/pages/SettingsGitHub.tsx` — replace inline styles with Tailwind classes
- [ ] T055 [P] [US1] Migrate `apps/web/src/pages/SettingsAgentKeys.tsx` and `apps/web/src/pages/SettingsAgentConfig.tsx` — replace inline styles with Tailwind classes
- [ ] T056 [P] [US1] Migrate `apps/web/src/components/HetznerTokenForm.tsx` — replace inline styles with Tailwind classes
- [ ] T057 [P] [US1] Migrate `apps/web/src/components/AgentSettingsSection.tsx`, `apps/web/src/components/AgentKeysSection.tsx`, `apps/web/src/components/AgentKeyCard.tsx` — replace inline styles with Tailwind classes
- [ ] T058 [P] [US1] Migrate `apps/web/src/components/GitHubAppSection.tsx` — replace inline styles with Tailwind classes

### Pages: Projects & Tasks

- [ ] T059 [P] [US1] Migrate `apps/web/src/pages/Projects.tsx` and `apps/web/src/pages/ProjectCreate.tsx` — replace inline styles with Tailwind classes
- [ ] T060 [P] [US1] Migrate `apps/web/src/components/project/ProjectForm.tsx` and `apps/web/src/components/project/ProjectInfoPanel.tsx` — replace inline styles with Tailwind classes
- [ ] T061 [P] [US1] Migrate `apps/web/src/pages/Project.tsx`, `apps/web/src/pages/ProjectContext.tsx`, `apps/web/src/pages/ProjectOverview.tsx` — replace inline styles with Tailwind classes
- [ ] T062 [P] [US1] Migrate `apps/web/src/pages/ProjectSettings.tsx` and `apps/web/src/components/project/SettingsDrawer.tsx` — replace inline styles with Tailwind classes
- [ ] T063 [P] [US1] Migrate `apps/web/src/pages/ProjectActivity.tsx` and `apps/web/src/components/ActivityFeed.tsx` — replace inline styles with Tailwind classes
- [ ] T064 [P] [US1] Migrate `apps/web/src/pages/ProjectSessions.tsx` and `apps/web/src/pages/ChatSessionView.tsx` — replace inline styles with Tailwind classes
- [ ] T065 [P] [US1] Migrate `apps/web/src/pages/ProjectTasks.tsx`, `apps/web/src/pages/ProjectKanban.tsx` — replace inline styles with Tailwind classes
- [ ] T066 [P] [US1] Migrate `apps/web/src/components/project/TaskList.tsx`, `apps/web/src/components/project/TaskForm.tsx`, `apps/web/src/components/project/TaskFilters.tsx` — replace inline styles with Tailwind classes
- [ ] T067 [P] [US1] Migrate `apps/web/src/components/project/TaskDelegateDialog.tsx`, `apps/web/src/components/project/TaskDependencyEditor.tsx`, `apps/web/src/components/project/NeedsAttentionSection.tsx` — replace inline styles with Tailwind classes
- [ ] T068 [P] [US1] Migrate `apps/web/src/pages/TaskDetail.tsx` — replace inline styles + remove `<style>` injection, use Tailwind breakpoints
- [ ] T069 [P] [US1] Migrate `apps/web/src/components/task/TaskKanbanCard.tsx`, `apps/web/src/components/task/TaskKanbanBoard.tsx`, `apps/web/src/components/task/TaskSubmitForm.tsx` — replace inline styles with Tailwind classes
- [ ] T070 [P] [US1] Migrate `apps/web/src/components/ProjectSummaryCard.tsx` — replace inline styles with Tailwind classes

### Pages: Chat

- [ ] T071 [P] [US1] Migrate `apps/web/src/pages/ProjectChat.tsx` — replace inline styles, remove `<style>` drawer animation block (keyframes extracted in T013)
- [ ] T072 [P] [US1] Migrate `apps/web/src/components/chat/SessionSidebar.tsx` and `apps/web/src/components/chat/ProjectMessageView.tsx` — replace inline styles with Tailwind classes
- [ ] T073 [P] [US1] Migrate `apps/web/src/components/ChatSession.tsx` and `apps/web/src/components/ChatSessionList.tsx` — replace inline styles, remove `<style>` hover injection from ChatSessionList

### Pages: Nodes

- [ ] T074 [P] [US1] Migrate `apps/web/src/pages/Nodes.tsx` — replace inline styles, remove `<style>` responsive grid injection, use Tailwind breakpoints
- [ ] T075 [P] [US1] Migrate `apps/web/src/pages/Node.tsx` — replace inline styles with Tailwind classes
- [ ] T076 [P] [US1] Migrate `apps/web/src/components/node/NodeCard.tsx`, `apps/web/src/components/node/NodeOverviewSection.tsx`, `apps/web/src/components/node/SectionHeader.tsx`, `apps/web/src/components/node/Section.tsx` — replace inline styles with Tailwind classes
- [ ] T077 [P] [US1] Migrate `apps/web/src/components/node/ResourceBar.tsx`, `apps/web/src/components/node/MiniMetricBadge.tsx`, `apps/web/src/components/node/SystemResourcesSection.tsx` — replace inline styles with Tailwind classes
- [ ] T078 [P] [US1] Migrate `apps/web/src/components/node/DockerSection.tsx`, `apps/web/src/components/node/SoftwareSection.tsx`, `apps/web/src/components/node/NodeWorkspacesSection.tsx`, `apps/web/src/components/node/NodeWorkspaceMiniCard.tsx` — replace inline styles with Tailwind classes
- [ ] T079 [P] [US1] Migrate `apps/web/src/components/node/LogsSection.tsx`, `apps/web/src/components/node/LogEntry.tsx`, `apps/web/src/components/node/LogFilters.tsx`, `apps/web/src/components/node/NodeEventsSection.tsx` — replace inline styles with Tailwind classes

### Pages: Workspace

- [ ] T080 [P] [US1] Migrate `apps/web/src/pages/Workspace.tsx` and `apps/web/src/pages/CreateWorkspace.tsx` — replace inline styles with Tailwind classes
- [ ] T081 [P] [US1] Migrate `apps/web/src/components/WorkspaceCard.tsx`, `apps/web/src/components/WorkspaceSidebar.tsx`, `apps/web/src/components/WorkspaceTabStrip.tsx` — replace inline styles, remove `<style>` hover injection from WorkspaceTabStrip
- [ ] T082 [P] [US1] Migrate `apps/web/src/components/GitChangesPanel.tsx`, `apps/web/src/components/GitChangesButton.tsx`, `apps/web/src/components/GitDiffView.tsx` — replace inline styles, remove `<style>` injection from GitChangesPanel
- [ ] T083 [P] [US1] Migrate `apps/web/src/components/FileBrowserPanel.tsx`, `apps/web/src/components/FileBrowserButton.tsx`, `apps/web/src/components/FileViewerPanel.tsx` — replace inline styles with Tailwind classes
- [ ] T084 [P] [US1] Migrate `apps/web/src/components/WorktreeSelector.tsx`, `apps/web/src/components/BranchSelector.tsx`, `apps/web/src/components/RepoSelector.tsx` — replace inline styles with Tailwind classes

### Pages: Admin

- [ ] T085 [P] [US1] Migrate `apps/web/src/pages/Admin.tsx`, `apps/web/src/pages/AdminOverview.tsx`, `apps/web/src/pages/AdminUsers.tsx` — replace inline styles with Tailwind classes
- [ ] T086 [P] [US1] Migrate `apps/web/src/pages/AdminErrors.tsx`, `apps/web/src/pages/AdminLogs.tsx`, `apps/web/src/pages/AdminStream.tsx` — replace inline styles with Tailwind classes
- [ ] T087 [P] [US1] Migrate `apps/web/src/components/admin/HealthOverview.tsx`, `apps/web/src/components/admin/ErrorList.tsx`, `apps/web/src/components/admin/ErrorTrends.tsx` — replace inline styles with Tailwind classes
- [ ] T088 [P] [US1] Migrate `apps/web/src/components/admin/LogViewer.tsx`, `apps/web/src/components/admin/LogStream.tsx`, `apps/web/src/components/admin/ObservabilityFilters.tsx`, `apps/web/src/components/admin/ObservabilityLogEntry.tsx` — replace inline styles with Tailwind classes

### Remaining

- [ ] T089 [P] [US1] Migrate `apps/web/src/components/ui/SplitButton.tsx` — replace inline styles, remove `<style>` hover injection
- [ ] T090 [P] [US1] Migrate `apps/web/src/pages/UiStandards.tsx` — replace inline styles with Tailwind classes
- [ ] T091 [US1] Migrate `apps/web/src/pages/Dashboard.tsx` — replace inline styles, remove `<style>` responsive grid injection, use Tailwind breakpoints (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`)
- [ ] T092 [US1] Full build verification: run `pnpm build` from repo root to confirm all packages build successfully

**Checkpoint**: All web app components migrated. SC-002 (zero runtime `<style>` injections) and SC-008 (90%+ inline styles replaced) should be achieved.

---

## Phase 5: User Story 2 - Responsive Layouts Without Custom Media Queries (Priority: P2)

**Goal**: Verify and refine all responsive layouts to use Tailwind breakpoint prefixes. Most responsive migration happens during Phase 4 (inline `<style>` removal), but this phase validates the result.

**Independent Test**: View Dashboard, Landing, Nodes, and TaskDetail pages at mobile, tablet, and desktop widths — all layouts reflow correctly.

- [ ] T093 [US2] Verify Dashboard responsive grid uses `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` (migrated in T091) — test at 375px, 768px, and 1280px viewport widths
- [ ] T094 [US2] Verify Landing page responsive grid uses `grid-cols-1 sm:grid-cols-3` (migrated in T050) — test at 375px and 768px viewport widths
- [ ] T095 [US2] Verify Nodes page responsive grid uses `grid-cols-1 md:grid-cols-2` (migrated in T074) — test at 375px and 768px viewport widths
- [ ] T096 [US2] Verify TaskDetail page layout uses Tailwind breakpoints (migrated in T068) — test at 375px and 1024px viewport widths
- [ ] T097 [US2] Verify no remaining runtime `<style>` tags contain `@media` queries — search codebase for `@media` in TSX files

**Checkpoint**: All responsive layouts use Tailwind breakpoint prefixes. Zero ad-hoc media queries in components.

---

## Phase 6: User Story 3 - Design Token Integration With Utility Classes (Priority: P2)

**Goal**: Validate that the `@theme` token mapping is complete and that developers can use semantic token classes (`bg-surface`, `text-fg-muted`, `z-dialog`, etc.) for all design tokens.

**Independent Test**: Create a test component that uses every mapped token class and verify rendered output matches existing design.

- [ ] T098 [US3] Audit `apps/web/src/app.css` `@theme` block against `packages/ui/src/tokens/theme.css` — verify every SAM CSS variable has a corresponding `@theme` mapping per data-model.md
- [ ] T099 [US3] Verify color tint tokens (`accent-tint`, `success-tint`, etc.) and semantic fg tokens (`success-fg`, `danger-fg`, etc.) are mapped in `@theme` and usable as Tailwind classes
- [ ] T100 [US3] Verify z-index tokens (`z-sticky`, `z-dropdown`, `z-drawer`, `z-dialog`, `z-panel`, `z-command-palette`) are mapped and used in Dialog, DropdownMenu, Toast, CommandPalette, MobileNavDrawer
- [ ] T101 [US3] Verify shadow tokens (`shadow-sm` through `shadow-xl`, `shadow-dropdown`, `shadow-overlay`, `shadow-tooltip`) render correctly with dark-tuned values

**Checkpoint**: Complete token integration verified. All SAM design tokens accessible as Tailwind utility classes.

---

## Phase 7: User Story 5 - Incremental Migration Path (Priority: P3)

**Goal**: This is inherently validated throughout Phases 3-4. This phase does a final coexistence check and documents the pattern.

**Independent Test**: Build succeeds, all pages render correctly, no CSS conflicts between any remaining inline styles and Tailwind classes.

- [ ] T102 [US5] Final coexistence verification: run `pnpm build` and confirm zero build errors or CSS warnings
- [ ] T103 [US5] Search for any remaining `CSSProperties` type annotations in `apps/web/src/` — document any that intentionally remain (e.g., dynamic computed styles that can't be expressed as classes)
- [ ] T104 [US5] Copy `specs/024-tailwind-adoption/quickstart.md` to `docs/guides/tailwind-usage.md` for permanent developer documentation

**Checkpoint**: Migration complete. Incremental approach validated. Developer guide in place.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, cleanup, and documentation.

- [ ] T105 Build time benchmark: compare `pnpm --filter @simple-agent-manager/web build` time before and after migration — confirm < 20% increase (SC-006)
- [ ] T106 Production CSS size check: build production bundle and measure gzipped CSS output — confirm < 50KB (SC-003)
- [ ] T107 Run `pnpm typecheck` from repo root — confirm zero type errors
- [ ] T108 Run `pnpm lint` from repo root — confirm zero lint errors
- [ ] T109 Run `pnpm test` from repo root — confirm all existing tests pass
- [ ] T110 Capture post-migration Playwright screenshots of key pages (Dashboard, Project, Workspace, Settings, Admin) and compare against baseline screenshots from T007a — confirm no visual regressions (SC-004)
- [ ] T111 Update `CLAUDE.md` Active Technologies section to include Tailwind CSS v4
- [ ] T112 Run quickstart.md validation: verify all code examples in `specs/024-tailwind-adoption/quickstart.md` use correct class names that match the `@theme` configuration

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all component migration
- **UI Package (Phase 3)**: Depends on Phase 2 — can run independently of web app phases
- **Web App (Phase 4)**: Depends on Phase 2 — can start in parallel with Phase 3
- **Responsive (Phase 5)**: Depends on Phase 4 — validation of responsive migrations done in Phase 4
- **Tokens (Phase 6)**: Depends on Phase 1 (config) — can run in parallel with Phases 3-4
- **Coexistence (Phase 7)**: Depends on Phases 3 + 4 completion
- **Polish (Phase 8)**: Depends on all prior phases

### User Story Dependencies

- **US4 (UI Package)**: Can start after Phase 2 — no dependencies on other stories
- **US1 (Web App)**: Can start after Phase 2 — may run in parallel with US4
- **US2 (Responsive)**: Depends on US1 (responsive migrations happen during web app migration)
- **US3 (Tokens)**: Can start after Phase 1 — mostly independent (validation)
- **US5 (Coexistence)**: Depends on US1 + US4 — final validation

### Within Each Phase

- Tasks marked [P] can run in parallel
- Batch ordering within Phase 3 is recommended (simple → complex) but not strictly required
- Phase 4 tasks are all [P] — can all run in parallel since they modify different files

### Parallel Opportunities

**Maximum parallelism during Phase 4**: All 60 web app migration tasks (T033-T092) modify different files and can theoretically run in parallel. In practice, batch by feature area:

```
Parallel batch A: Layout (T033-T038)
Parallel batch B: Shared components (T039-T046)
Parallel batch C: Auth + Settings (T047-T058)
Parallel batch D: Projects + Tasks (T059-T070)
Parallel batch E: Chat + Nodes + Workspace (T071-T084)
Parallel batch F: Admin (T085-T088)
```

---

## Parallel Example: UI Package (Phase 3)

```
# Batch 1 — all parallel (different files):
T016: StatusBadge.tsx
T017: Spinner.tsx
T018: Input.tsx
T019: Select.tsx

# Batch 2 — all parallel:
T020: Card.tsx
T021: ButtonGroup.tsx
T022: Tooltip.tsx
T023: Skeleton.tsx

# Batch 3 — all parallel:
T024: Alert.tsx
T025: Button.tsx
T026: Breadcrumb.tsx
T027: Tabs.tsx

# Batch 4 — sequential (more complex, benefit from patterns established above):
T028: Dialog.tsx
T029: DropdownMenu.tsx
T030: Toast.tsx
T031: EmptyState.tsx

# Batch 5 — all parallel (primitives):
T031a: Typography.tsx
T031b: Container.tsx
T031c: PageLayout.tsx
```

---

## Implementation Strategy

### MVP First (Phase 1 + 2 + 3 only)

1. Complete Phase 1: Setup (T001-T007a)
2. Complete Phase 2: Foundation (T008-T015)
3. Complete Phase 3: UI Package (T016-T032, including T031a-T031c primitives)
4. **STOP and VALIDATE**: All 19 styled UI components use Tailwind, build succeeds, visual output unchanged
5. This alone achieves SC-001 and SC-007

### Incremental Delivery

1. Phase 1 + 2 → Infrastructure ready
2. + Phase 3 → UI package migrated (SC-001, SC-007)
3. + Phase 4 → Web app migrated (SC-002, SC-008)
4. + Phase 5 → Responsive layouts validated
5. + Phase 6 → Token integration verified
6. + Phase 7 + 8 → Polish, benchmarks, documentation

### Parallel Strategy

With multiple developers:
- Developer A: Phase 3 (UI package)
- Developer B: Phase 4 batches A-C (Layout, Shared, Auth/Settings)
- Developer C: Phase 4 batches D-F (Projects, Chat/Nodes, Admin)
- All converge at Phase 5+ for validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each batch within a phase can be implemented as a single PR or split per-component
- Visual verification is manual (compare before/after appearance) unless Playwright screenshot tests are added
- The `vm-agent/ui` package is explicitly out of scope per research.md
- Stop at any checkpoint to validate independently
