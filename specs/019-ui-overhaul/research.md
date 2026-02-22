# Research: UI/UX Overhaul

**Feature**: 019-ui-overhaul
**Date**: 2026-02-22
**Status**: Complete

## R1: Component Positioning Strategy (DropdownMenu, Tooltip)

**Decision**: Build custom positioning with `position: absolute` (anchored) and `position: fixed` (modals), no external library.

**Rationale**: The codebase already has 5+ overlay implementations using this exact pattern (UserMenu, TabOverflowMenu, WorktreeSelector, ConfirmDialog, CommandPalette). All use `useRef` + `mousedown` for click-outside, and global `keydown` for Escape. Adding `@floating-ui/react` would introduce a new dependency for a pattern the project already handles. Constitution Principle X (Simplicity) requires dependency justification.

**Alternatives Considered**:
- `@floating-ui/react`: Better positioning math (viewport overflow, auto-placement) but adds runtime dependency for features we can approximate with CSS `max-height`/`overflow` and manual offset.
- `@radix-ui/react-dropdown-menu`: Full accessibility out of the box but brings a large dependency tree and its own styling approach that conflicts with the SAM design token system.
- Popover API (native): Partial browser support (no Safari < 17), insufficient for our mobile-first requirement.

**Existing Patterns to Reuse**:
- Click-outside: `useRef<HTMLDivElement>` + `document.addEventListener('mousedown', ...)` (from UserMenu.tsx)
- Escape dismiss: `document.addEventListener('keydown', ...)` with `e.key === 'Escape'` (from Dialog.tsx)
- Mobile adaptation: `useIsMobile()` hook to switch between `absolute` (desktop) and `fixed` full-screen (mobile) (from WorktreeSelector.tsx)
- Body scroll lock: `document.body.style.overflow = 'hidden'` (from Dialog.tsx)

**New Hooks to Extract**:
- `useClickOutside(ref, callback)` — DRY up the repeated click-outside pattern
- `useEscapeKey(callback, enabled?)` — DRY up the repeated escape key pattern

## R2: Z-Index Strategy

**Decision**: Extend existing hierarchy with documented layers.

**Rationale**: The codebase has an implicit but consistent z-index scale. Formalizing it prevents collisions as we add DropdownMenu and Tooltip.

| Layer | Z-Index | Use |
|-------|---------|-----|
| Base content | 0 | Page content |
| Sticky headers | 10 | Fixed navigation elements |
| Dropdowns | 20 | DropdownMenu, Tooltip (anchored overlays) |
| Drawer backdrop | 40 | Mobile nav overlay |
| Drawer panel | 41 | Mobile nav panel |
| Dialog backdrop | 50 | Modal overlays |
| Dialog content | 51 | Modal content |
| Full-screen panels | 60 | Git changes, file browser |
| Command palette | 61 | Command palette (above panels) |

## R3: React Router Nested Routes Strategy

**Decision**: Use React Router v6 nested routes with `<Outlet />` for project detail and settings sub-sections.

**Rationale**: React Router 6 (already installed) natively supports nested routes with `<Outlet />`. The current flat route structure (`/projects/:id` rendering everything) can be refactored to parent + child routes. This enables:
- URL-addressable sub-sections (`/projects/:id/tasks`)
- Shared layout between sub-sections (project header + tabs stay mounted)
- Lazy loading of sub-section content
- Browser back/forward navigation between tabs

**Current State**:
- All routes are flat in `App.tsx` (no nesting)
- Project detail uses `?tab=tasks` search param for tab switching
- `<Outlet />` is not used anywhere
- React Router v6 is installed (supports nested routes natively)

**Migration Path**:
1. Convert `/projects/:id` route to a parent route with `<Outlet />`
2. Add child routes: `overview` (index), `tasks`, `sessions`, `settings`, `activity`
3. Extract tab content from monolithic Project.tsx into separate page components
4. Project.tsx becomes a shell: header + Tabs + `<Outlet />`
5. Same pattern for Settings page

**Alternatives Considered**:
- Client-side tab state only (no routing): Would not enable URL sharing or bookmarking of sub-sections. Rejected per FR-009.
- Hash routing (`#tasks`): Non-standard, doesn't work with server-side rendering. Rejected.
- Keep search params (`?tab=tasks`): Already in use but doesn't enable lazy loading or shared layout. Rejected per FR-008/FR-009.

## R4: Typography Scale Design

**Decision**: 6-tier scale using CSS custom properties, extending the existing `--sam-*` token namespace.

**Rationale**: The audit found 314 inline `fontSize` declarations across 56 files. The current scale has no named tiers — just raw rem values. Page titles and section headings differ by only 0.25rem, making hierarchy nearly invisible. A named 6-tier scale with distinct sizes and weights creates clear visual hierarchy.

**Typography Scale**:

| Tier | Token | Size | Weight | Line Height | Use |
|------|-------|------|--------|-------------|-----|
| Page Title | `--sam-type-page-title` | 1.5rem (24px) | 700 | 1.2 | Top-level page headings |
| Section Heading | `--sam-type-section-heading` | 1.125rem (18px) | 600 | 1.3 | Card headers, section titles |
| Card Title | `--sam-type-card-title` | 1rem (16px) | 600 | 1.4 | Entity names in lists, form labels |
| Body | `--sam-type-body` | 0.9375rem (15px) | 400 | 1.5 | Primary content text |
| Secondary | `--sam-type-secondary` | 0.875rem (14px) | 400 | 1.5 | Supporting text, descriptions |
| Caption | `--sam-type-caption` | 0.75rem (12px) | 400 | 1.4 | Timestamps, metadata, labels |

**Token Format** (in theme.css):
```css
:root {
  --sam-type-page-title-size: 1.5rem;
  --sam-type-page-title-weight: 700;
  --sam-type-page-title-line-height: 1.2;
  /* ... etc for each tier */
}
```

**Alternatives Considered**:
- Tailwind-style utility classes only: Project doesn't use Tailwind; adding utility-only approach would create a parallel system alongside design tokens.
- Fixed pixel sizes: Violates accessibility (users can't scale text). Rem-based sizing is required.
- Fewer tiers (4): Not enough granularity. The audit showed 8+ distinct font sizes in use; collapsing to 4 would force too many compromises.

## R5: Navigation Layout Pattern

**Decision**: Sidebar navigation on desktop, hamburger-triggered drawer on mobile, with AppShell wrapper component.

**Rationale**: The audit compared 7 competitors: all use persistent navigation (top bar, sidebar, or both). A sidebar is preferred because:
- It accommodates growth (more nav items) without horizontal overflow
- It leaves the full page width for content
- It matches the project-first mental model (sidebar = project context)
- Mobile drawer already exists (MobileNavDrawer.tsx) and can be integrated

**Implementation**:
- `AppShell` component wraps all protected routes
- Desktop (>= 768px): Fixed sidebar (200-240px width) + content area
- Mobile (< 768px): No sidebar; hamburger button opens existing MobileNavDrawer
- Workspace detail page: No AppShell (full-width terminal)

**Alternatives Considered**:
- Top bar navigation: Already exists in header. Limited horizontal space; doesn't scale well with more sections.
- Combined top bar + sidebar: Over-engineered for 4 nav items. Principle X (Simplicity).
- Collapsible sidebar: Nice-to-have but adds complexity. Can be added later if needed.

## R6: Inline Style Remediation Strategy

**Decision**: Phased remediation using CSS classes + design token variables, not a CSS-in-JS migration.

**Rationale**: The audit found 674+ inline style violations across 56+ files. A full CSS-in-JS migration (styled-components, emotion) would be a larger change than the overhaul itself. Instead, replace inline styles with:
1. CSS classes in component-scoped `<style>` blocks (already used in some components)
2. Shared utility classes in `index.css` for common patterns
3. Design token CSS variables for all values

**Remediation Tiers**:

| Tier | Pattern | Count | Priority |
|------|---------|-------|----------|
| 1 | `onMouseEnter`/`onMouseLeave` hover handlers | 35 | P1 — Replace with CSS `:hover` classes |
| 2 | Hardcoded hex colors (`#xxx`) | 118 | P1 — Map to `--sam-color-*` tokens |
| 3 | Hardcoded `rgba()` values | 118 | P1 — Create semantic tokens for tinted backgrounds |
| 4 | Inline `fontSize` | 314 | P2 — Map to typography scale tokens |
| 5 | Repeated border patterns | 89 | P2 — Use shared Card/Section components |

**New Tokens Needed**:
- `--sam-color-accent-primary-tint`: `rgba(22, 163, 74, 0.1)` (green 10%)
- `--sam-color-warning-tint`: `rgba(245, 158, 11, 0.1)` (amber 10%)
- `--sam-color-danger-tint`: `rgba(239, 68, 68, 0.1)` (red 10%)
- `--sam-color-success-tint`: `rgba(34, 197, 94, 0.1)` (green 10%)
- `--sam-shadow-overlay`: `0 8px 32px rgba(0, 0, 0, 0.4)` (currently hardcoded in multiple places)
- `--sam-shadow-dropdown`: `0 4px 16px rgba(0, 0, 0, 0.3)`

**Worst-Offender Files** (address first):
1. `pages/TaskDetail.tsx` — 30+ issues
2. `pages/Workspace.tsx` — 24+ issues
3. `pages/Project.tsx` — 24+ issues
4. `components/WorkspaceSidebar.tsx` — 30+ issues (mostly git-status colors)
5. `components/WorkspaceTabStrip.tsx` — 32+ issues
6. `components/WorkspaceCard.tsx` — 24+ issues

## R7: Entity List Overflow Menu Pattern

**Decision**: Three-dot icon (`MoreVertical` from lucide-react) triggering DropdownMenu with state-aware action items.

**Rationale**: All 7 competitors in the audit use overflow menus (three-dot icon) for secondary actions. The current pattern shows 2-4 visible action buttons per workspace/node card. Replacing with a single primary action + overflow menu reduces visual noise by ~60%.

**Implementation**:
- Primary action visible: "Open" (running workspace), "Start" (stopped workspace)
- Overflow menu contains: Stop, Restart, Delete, Rename (workspace); Stop, Delete (node)
- Menu items are conditionally rendered based on entity state
- Disabled items shown with visual indicator + tooltip explaining why

**Alternatives Considered**:
- Swipe actions (mobile): Platform-specific, not discoverable, breaks web conventions.
- Right-click context menu: Not discoverable, requires two interaction modes.
- Hover-reveal actions: Breaks mobile (no hover), creates "mystery meat navigation".

## R8: Onboarding Checklist Data Source

**Decision**: Derive checklist state from existing API data (user settings, workspace list), no new backend endpoints needed.

**Rationale**: Setup completeness can be determined from data already available:
1. **Hetzner token configured**: Check if user has a stored Hetzner token (settings API already returns this)
2. **GitHub App installed**: Check if GitHub App installation exists (settings API already returns this)
3. **First workspace created**: Check if workspace list is non-empty (workspaces API already returns this)

No new database columns or API endpoints required. The checklist is a pure frontend concern.

**Persistence**: Use `localStorage` to track if onboarding has been dismissed, keyed by user ID.
