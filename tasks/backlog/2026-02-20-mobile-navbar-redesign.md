# Mobile Navigation Redesign

**Created**: 2026-02-20
**Priority**: High
**Relates to**: Workspace page layout, standard page layout, mobile UX, UserMenu

## Problem Statement

The mobile navigation is severely broken on viewports <= 767px wide. Two distinct problems exist:

### 1. Workspace Header Overflow (Critical)

On mobile, the workspace `<header>` tries to fit ~467px of content into a 375px viewport:

| Element | Min Width |
|---------|-----------|
| Back button | 44px |
| Workspace name + badge | flex:1 (crushed to ~0) |
| WorktreeSelector | 44px |
| FileBrowserButton | 36px |
| GitChangesButton | 36px |
| CommandPaletteButton | 36px |
| Mobile menu (dots) | 36px |
| **UserMenu** (4 nav links + avatar) | **~235px** |
| **Total** | **~467px** |

The `UserMenu` component renders 4 full navigation links (Dashboard, Projects, Nodes, Settings) capped at `min(52vw, 36rem)` (~195px on 375px screen) plus a 32px avatar with chevron. This component was designed for `PageLayout` standard pages where it's the only element in `headerRight`. When placed inside the workspace header alongside 5+ icon buttons, it overflows badly.

### 2. Standard Pages Nav Crowding (Medium)

On standard pages (Dashboard, Projects, Nodes, Settings), the `UserMenu` renders all 4 nav links inline in the header. At 375px, these are crammed into ~195px of scrollable horizontal space. The nav links have no visual affordance that they're scrollable, and the active page link is often hidden off-screen.

### 3. Z-Index Inconsistencies (Low)

- UserMenu dropdown: z-index 10 (lowest of all popups)
- Tab create menu: z-index 30
- ConfirmDialog: z-index 50 (behind file/git panels at z-index 60)

## Root Cause

`UserMenu` has zero mobile/context-awareness. It always renders the full `sam-primary-nav` regardless of viewport size or which page it's on. The workspace page's header has no `overflow` control, so content either overflows or gets clipped by the parent's `overflow: hidden`.

## Design: Dual-Mode Mobile Navigation

Apply the **Priority+ pattern** with **progressive disclosure** — the two most effective patterns for action-dense mobile UIs.

### Approach: Context-Aware UserMenu

The `UserMenu` component needs to know where it lives and adapt:

#### On Standard Pages (Dashboard, Projects, Nodes, Settings)

**Mobile (<=767px):**
- Hide inline nav links entirely
- Show a hamburger/menu icon button next to the avatar
- Tapping the menu opens a slide-out drawer or bottom sheet containing:
  - User info (name, email, avatar)
  - Nav links (Dashboard, Projects, Nodes, Settings) — vertical list with active indicator
  - Sign out button
- The drawer uses proper z-index (z-index 50+ to sit above page content)

**Desktop (>767px):**
- Keep current inline nav links + avatar dropdown (works fine at wider viewports)

#### On Workspace Page

**Mobile (<=767px):**
- `UserMenu` renders as avatar-only icon button (32px circle)
- Tapping opens the same slide-out drawer with nav links + sign out
- All workspace-specific actions stay in the existing mobile sidebar (MoreVertical dots menu)
- This reduces UserMenu's footprint from ~235px to ~40px, freeing space for workspace controls

**Desktop (>767px):**
- Keep current inline nav links (space permits)

### Workspace Header Reorganization (Mobile)

With UserMenu shrunk to avatar-only (~40px), the mobile header budget becomes:

| Element | Width |
|---------|-------|
| Back button | 44px |
| Workspace name + badge | flex:1 (~107px available) |
| WorktreeSelector | 44px |
| FileBrowserButton | 36px |
| GitChangesButton | 36px |
| Mobile menu (dots) | 36px |
| UserMenu (avatar only) | 40px |
| **Total** | **~343px** (fits in 375px with gaps) |

The CommandPaletteButton on mobile can move into the mobile sidebar menu (it's already a low-frequency action accessed via Cmd+K on desktop).

### Mobile Navigation Drawer Component

Create a new `MobileNavDrawer` component:

```
Slide-in from right (or bottom sheet)
┌──────────────────────────┐
│  [Avatar]  User Name     │
│  user@email.com          │
├──────────────────────────┤
│  ● Dashboard             │
│    Projects              │
│    Nodes                 │
│    Settings              │
├──────────────────────────┤
│  Sign out                │
└──────────────────────────┘
```

- Backdrop: fixed inset 0, z-index 50 (consistent with existing mobile sidebar)
- Panel: fixed, right: 0, width: 85vw, max-width: 320px, z-index 51
- Each nav item: min 48px height for touch targets
- Active item highlighted with accent color
- Smooth slide-in transition (200ms ease-out)
- Close on backdrop tap, escape key, or navigation

### Z-Index Normalization

Establish consistent z-index layers:

| Layer | z-index | Usage |
|-------|---------|-------|
| Dropdowns | 20 | UserMenu dropdown, create menu, worktree selector (desktop) |
| Overlays | 50-51 | Mobile sidebar, mobile nav drawer, confirm dialogs |
| Panels | 60-61 | File browser, git changes, keyboard shortcuts |
| Command palette | 62 | Command palette (above panels) |
| Worktree mobile | 70-71 | Worktree selector mobile overlay |

## Implementation Checklist

- [ ] Add `variant` prop to `UserMenu`: `'full'` (default, current behavior) vs `'compact'` (avatar-only + drawer)
- [ ] Create `MobileNavDrawer` component with slide-in animation, nav links, sign out
- [ ] Update `UserMenu` to auto-detect mobile via `useIsMobile()` and render compact variant
- [ ] Update workspace `<header>` to not render CommandPaletteButton inline on mobile (move to sidebar)
- [ ] Fix z-index layering across all popup/overlay components
- [ ] Add unit tests for `MobileNavDrawer` (render, open/close, navigation, sign out)
- [ ] Add unit tests for `UserMenu` compact variant (renders avatar-only on mobile)
- [ ] Verify with Playwright on 375x667 viewport: workspace header fits without overflow
- [ ] Verify with Playwright on 375x667 viewport: standard pages nav drawer works
- [ ] Verify on desktop: no regressions to existing nav behavior

## Files to Modify

- `apps/web/src/components/UserMenu.tsx` — Add mobile detection and compact mode
- `apps/web/src/components/MobileNavDrawer.tsx` — New component (slide-in nav drawer)
- `apps/web/src/pages/Workspace.tsx` — Remove CommandPaletteButton from inline mobile header
- Various overlay components — Z-index normalization

## Design References

- **Priority+ pattern**: Show primary actions, overflow rest into a menu ([Mobile Navigation Patterns 2026](https://phone-simulator.com/blog/mobile-navigation-patterns-in-2026))
- **Progressive disclosure**: Reveal features as needed, don't front-load everything ([Mobile App UI Design Best Practices](https://uidesignz.com/blogs/mobile-ui-design-best-practices))
- **Thumb-friendly placement**: Keep primary actions in the thumb zone, min 44-48px touch targets ([Droids On Roids Guide](https://www.thedroidsonroids.com/blog/mobile-app-ui-design-guide))
- **Dev tool toolbar patterns**: Avoid toolbar clutter, use context-aware actions ([Evil Martians Dev Tool UIs](https://evilmartians.com/chronicles/keep-it-together-5-essential-design-patterns-for-dev-tool-uis))
