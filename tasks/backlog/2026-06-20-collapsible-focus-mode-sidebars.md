# Collapsible "Focus Mode" Sidebars (Desktop) → Production

**SAM idea:** `01KVK5TMZXFA1YQC1M8KYEGZ2F`
**Prototype source (throwaway, to be removed):** `apps/web/src/pages/sidebar-collapse-prototype/` (route `/prototype/sidebar-collapse`)

## Problem Statement

The desktop UI has two persistent sidebars that consume horizontal space and
cannot be collapsed:

- **Global/project nav** — owned by `AppShell.tsx`, hardcoded 220px grid column.
- **Chat session list** — owned by `pages/project-chat/index.tsx`, a `w-72`
  (288px) flex child inside the main content column.

Users want to reclaim reading width. The validated prototype introduces a
coordinated three-state **Focus Mode** (Default → Focus → Zen) that collapses
both sidebars together via one toggle. Ship it to production (desktop only;
mobile keeps its existing drawers).

## Research Findings

1. **Split ownership is the crux.** The two sidebars live in different
   components with different layout mechanisms (grid column vs flex child), so a
   single coordinated mode needs **shared cross-component state**.
   `AppShellContext` already exists (provides `setProjectName`) — extend it with
   `focusMode` + setters. `project-chat/index.tsx` renders inside AppShell's
   `<Outlet/>`, so it can consume the context. → checklist Phase 1, 2, 3.
2. **AppShell grid is hardcoded** (`AppShell.tsx:238`,
   `gridTemplateColumns: '220px 1fr'`). Collapsing the nav requires deriving the
   first column width from `focusMode`. → checklist Phase 2.
3. **`NavSidebar` is pure** (no self-owned width; AppShell sets the column). It
   needs an `iconOnly` prop to render the 56px icon rail. → checklist Phase 2.
4. **Attention icon map is duplicated.** The authoritative `ATTENTION_ICON_MAP`
   lives **un-exported** in `pages/project-chat/SessionItem.tsx`; the prototype
   mirrors it. Extract one shared `ATTENTION_ICON` map into
   `lib/chat-session-utils.ts` and consume it in both the strip and
   `SessionItem`. → checklist Phase 4.
5. **Body-portal tooltip pattern is required.** Glass ancestors
   (`glass-panel-container` = `contain:paint`, `glass-composited` =
   `transform`) clip/mis-stack a normal absolute tooltip. The prototype's
   `FocusStrip` renders the tooltip via `createPortal(..., document.body)` with
   fixed coords from `getBoundingClientRect()`. Port this. → checklist Phase 3.
6. **Zen seam must avoid hover flicker/trap.** Prototype stacks the two seams
   vertically (nav top-half, chats bottom-half) and makes the peek panel a DOM
   child of the hover wrapper so moving onto it does not fire `mouseleave`. Port
   verbatim. → checklist Phase 2/3.
7. **"F" hotkey is collision-risky** next to chat textareas. Guard against
   INPUT/TEXTAREA/contenteditable and only bind on desktop. → checklist Phase 1.
8. **Prototype must be removed before merge** (rule 37). → checklist Phase 8.

## Implementation Checklist

### Phase 1 — Shared Focus Mode state
- [ ] Add `FocusMode` type + extend `AppShellContext` with `focusMode`,
      `setFocusMode`, `cycleFocusMode`.
- [ ] Persist `focusMode` to `localStorage` (hydrate on mount), desktop only.
- [ ] Bind guarded "F" key handler in AppShell (ignore editable targets;
      desktop only).
- [ ] Gate the entire feature behind `!isMobile`.

### Phase 2 — AppShell nav collapse
- [ ] Derive grid column-1 width from `focusMode` (220 / 56 / 0). Animate with
      CSS transition; `motion-reduce` disables it.
- [ ] Add `iconOnly` prop to `NavSidebar` (hide labels, center icons, tooltips).
- [ ] Zen: render nav as a top-half edge-seam overlay (`ZenPeekRail`).
- [ ] Render `FocusModeToggle` in the AppShell desktop header.

### Phase 3 — Session sidebar collapse (project-chat)
- [ ] `project-chat/index.tsx` desktop sidebar reads `focusMode`:
      288px list / 64px `FocusStrip` / zen bottom-half seam.
- [ ] Port `FocusStrip` with body-portal tooltip rendering real
      `SessionTreeItem`.

### Phase 4 — De-duplicate attention model
- [ ] Add shared `ATTENTION_ICON` map to `lib/chat-session-utils.ts`.
- [ ] Consume it in `SessionItem.tsx` and the focus strip (remove duplicates).

### Phase 5 — Reusable building blocks
- [ ] Extract `FocusModeToggle`, `NavRail` (iconOnly), `FocusStrip`,
      `ZenPeekRail` into shared component files under `apps/web/src/components/`.

### Phase 6 — Accessibility
- [ ] Collapsed rails keep tab order; tooltips reachable via focus
      (onFocus/onBlur).
- [ ] `aria-pressed`/`aria-label` on toggle; zen seams get a focusable expand
      affordance.
- [ ] `prefers-reduced-motion` disables transitions.

### Phase 7 — Tests
- [ ] Behavioral test: render AppShell, toggle mode, assert grid width changes +
      persists to localStorage.
- [ ] Playwright visual audit retargeted at real routes (desktop 1280 + mobile
      375): all 3 modes, no horizontal overflow, tooltip parented to body, zen
      peek stable.

### Phase 8 — Remove prototype (REQUIRED before merge)
- [ ] Delete `apps/web/src/pages/sidebar-collapse-prototype/`.
- [ ] Remove `/prototype/sidebar-collapse` route from `App.tsx`.
- [ ] Remove/port `tests/playwright/sidebar-collapse-prototype-audit.spec.ts`.
- [ ] Grep for leftover prototype imports.

## Acceptance Criteria

- [ ] On desktop, a Focus Mode toggle in the AppShell header cycles
      Default → Focus → Zen, collapsing BOTH sidebars in a coordinated way.
- [ ] Default mode is the unchanged current layout (no behavior change until the
      user opts in).
- [ ] Focus mode shows a 56px nav icon rail + 64px session status strip; hovering
      a strip icon peeks the real chat card via a body-portal tooltip.
- [ ] Zen mode tucks both sidebars to glowing edge seams; hovering a seam peeks
      its panel without flicker.
- [ ] Mode persists across reloads (localStorage) and is desktop-only (mobile
      drawers untouched).
- [ ] `prefers-reduced-motion` disables the width/slide transitions.
- [ ] No horizontal overflow at 1280px in any mode; no console errors.
- [ ] The throwaway prototype + route + spec are removed; no leftover imports.

## References
- SAM idea `01KVK5TMZXFA1YQC1M8KYEGZ2F`
- `.claude/rules/37-prototype-development.md` (prototype removal)
- `.claude/rules/17-ui-visual-testing.md` (Playwright audit)
- `.claude/rules/16-no-page-reload-on-mutation.md`
