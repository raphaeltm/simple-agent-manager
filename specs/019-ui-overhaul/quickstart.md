# Quickstart: UI/UX Overhaul Development

**Feature**: 019-ui-overhaul
**Date**: 2026-02-22

## Prerequisites

- Node.js 18+, pnpm 8+
- Repository cloned with dependencies installed (`pnpm install`)
- Packages built in dependency order:
  ```bash
  pnpm --filter @simple-agent-manager/shared build
  pnpm --filter @simple-agent-manager/providers build
  ```

## Development Workflow

### 1. Start the Web Dev Server

```bash
pnpm --filter @simple-agent-manager/web dev
```

This starts Vite with hot reload. Open `http://localhost:5173` in your browser.

### 2. Build the UI Package After Token/Component Changes

When you modify `packages/ui/` (tokens, components, primitives), rebuild it:

```bash
pnpm --filter @simple-agent-manager/ui build
```

The web dev server will pick up changes via HMR.

### 3. Run Tests

```bash
# Unit tests for UI primitives
pnpm --filter @simple-agent-manager/ui test

# Unit tests for web app
pnpm --filter @simple-agent-manager/web test

# All tests
pnpm test
```

### 4. Type Check

```bash
pnpm typecheck
```

### 5. Lint and Format

```bash
pnpm lint
pnpm format
```

## Implementation Phases

### Phase 1: Design Tokens + Primitives (No page changes)

1. **Extend `theme.css`** with typography scale, tint colors, shadows, z-index tokens
2. **Add utility CSS classes** (`.sam-type-page-title`, `.sam-type-body`, etc.)
3. **Build primitives** in `packages/ui/src/components/`:
   - `DropdownMenu.tsx` — positioned menu with keyboard nav
   - `ButtonGroup.tsx` — grouped buttons with shared radius
   - `Tabs.tsx` — route-integrated tab strip
   - `Breadcrumb.tsx` — navigation path
   - `Tooltip.tsx` — hover explanation
   - `EmptyState.tsx` — no-data placeholder
4. **Extract hooks** in `packages/ui/src/hooks/` or `apps/web/src/hooks/`:
   - `useClickOutside(ref, callback)`
   - `useEscapeKey(callback)`
5. **Export all new components** from `packages/ui/src/index.ts`
6. **Add unit tests** for each primitive (keyboard nav, dismiss behavior, rendering)

### Phase 2: Navigation + Entity Lists

1. **Build `AppShell`** in `apps/web/src/components/AppShell.tsx`
   - Desktop sidebar with nav items
   - Mobile: hamburger + MobileNavDrawer
2. **Update `App.tsx`** routing to wrap protected routes in AppShell
3. **Refactor `WorkspaceCard`** — replace inline action buttons with DropdownMenu
4. **Refactor node list entries** — move metrics to detail page, add DropdownMenu
5. **Remove inline nav links from `UserMenu`** — navigation moves to AppShell sidebar
6. **Replace all `onMouseEnter`/`onMouseLeave`** with CSS `:hover` classes

### Phase 3: Page Restructuring

1. **Split `Project.tsx`** into shell + sub-route pages:
   - `Project.tsx` → header + Tabs + `<Outlet />`
   - `ProjectOverview.tsx` — summary stats, edit form
   - `ProjectTasks.tsx` — task list, filters, create
   - `ProjectSessions.tsx` — chat session list
   - `ProjectSettings.tsx` — runtime config (env vars, files)
   - `ProjectActivity.tsx` — activity feed
2. **Split `Settings.tsx`** into shell + sub-route pages
3. **Update `App.tsx`** with nested routes using `<Outlet />`
4. **Add Breadcrumb** to detail pages (Project, Node, Task, ChatSession)

### Phase 4: Dashboard + Onboarding

1. **Redesign `Dashboard.tsx`** — project-first layout
2. **Build `OnboardingChecklist`** component
3. **Add EmptyState** to all list pages

### Phase 5: Style Cleanup

1. **Replace all hardcoded hex/rgba colors** with design tokens
2. **Replace all inline `fontSize`** with typography CSS classes
3. **Replace repeated section styling** with shared Card/Section usage
4. **Audit: zero hardcoded colors, zero inline font sizes**

## Key Files to Understand

| File | Why |
|------|-----|
| `packages/ui/src/tokens/theme.css` | Design tokens (colors, spacing, typography) |
| `packages/ui/src/tokens/semantic-tokens.ts` | TypeScript token definitions |
| `packages/ui/src/index.ts` | All component exports |
| `apps/web/src/App.tsx` | Route definitions |
| `apps/web/src/components/UserMenu.tsx` | Current navigation pattern |
| `apps/web/src/components/WorkspaceCard.tsx` | Current entity card pattern |
| `apps/web/src/pages/Project.tsx` | Monolithic page to split |
| `apps/web/src/pages/Settings.tsx` | Single-page settings to split |
| `apps/web/src/pages/Dashboard.tsx` | Dashboard to redesign |
| `apps/web/src/hooks/useIsMobile.ts` | Mobile breakpoint hook |

## Testing Checklist

For each new primitive:
- [ ] Renders with all prop variants
- [ ] Keyboard navigation works (arrows, Enter, Escape, Tab)
- [ ] Click-outside dismisses (for overlays)
- [ ] Uses only design token values (no hardcoded colors/sizes)
- [ ] Works on mobile viewport (< 768px)
- [ ] Has `aria-*` attributes per contract spec
- [ ] Snapshot or visual regression test

For page restructuring:
- [ ] Direct URL access works for each sub-route
- [ ] Browser back/forward navigates between tabs
- [ ] Page refresh preserves active tab
- [ ] Data loads correctly for each sub-section
- [ ] Shared layout (header, tabs) doesn't re-mount on tab change

For style cleanup:
- [ ] `grep -r "fontSize:" apps/web/src/` returns zero results
- [ ] `grep -r "onMouseEnter" apps/web/src/` returns zero results
- [ ] `grep -rP "#[0-9a-fA-F]{3,8}" apps/web/src/components/ apps/web/src/pages/` returns zero results in component TSX files
