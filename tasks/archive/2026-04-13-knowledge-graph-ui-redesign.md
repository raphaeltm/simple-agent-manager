# Knowledge Graph UI Redesign

## Problem

The Knowledge Browser page (`KnowledgePage.tsx`) is visually inconsistent with the rest of the app and looks unpolished. Key issues:

1. **Inconsistent styling** — Uses raw `var(--sam-*)` CSS variables instead of semantic Tailwind classes (`text-fg-primary`, `bg-surface`, `border-border-default`) used everywhere else
2. **Bloated cards** — Entity cards have too much padding/spacing vs the compact `IdeaCard` pattern
3. **Filter chips overflow mobile** — 8 filter chips wrap to 2 rows at 375px, wasting screen real estate
4. **No max-width constraint** — List stretches full-width on desktop when no detail panel is open
5. **Create form broken on mobile** — Description field squished next to type select
6. **Delete buttons invisible on touch** — Uses `opacity-0 group-hover:opacity-100` which doesn't work with touch devices
7. **Observation cards visually heavy** — Individual borders on every observation creates noise
8. **No visual hierarchy** — Everything has equal weight

## Research Findings

### Current Patterns (from IdeasPage, ProfileList)
- Cards: `px-3 py-2.5 min-h-[56px] rounded-lg border border-border-default bg-surface hover:border-accent/40`
- Titles: `text-sm font-medium text-fg-primary line-clamp-1`
- Descriptions: `text-xs text-fg-muted line-clamp-1`
- Meta text: `text-xs text-fg-muted`
- Semantic tokens: `text-fg-primary`, `text-fg-muted`, `bg-surface`, `bg-surface-hover`, `border-border-default`
- Selected state: `border-accent bg-accent/5`
- Focus: `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`
- Touch targets: `min-h-[44px]` minimum

### Key Files
- `apps/web/src/pages/KnowledgePage.tsx` — main component (562 lines)
- `apps/web/src/pages/IdeasPage.tsx` — reference pattern
- `apps/web/tests/playwright/knowledge-ui-audit.spec.ts` — existing tests
- `apps/web/tests/playwright/knowledge-screenshot.spec.ts` — screenshot tests (created for audit)

## Implementation Checklist

- [ ] Replace all `var(--sam-*)` references with semantic Tailwind classes
  - `var(--sam-text-primary)` → `text-fg-primary`
  - `var(--sam-text-secondary)` → `text-fg-muted`
  - `var(--sam-border)` → `border-border-default`
  - `var(--sam-bg-primary)` → `bg-surface`
  - `var(--sam-bg-secondary)` → `bg-surface-inset`
  - `var(--sam-bg-hover)` → `bg-surface-hover`
  - `var(--sam-accent)` → `bg-accent` / `text-accent`
- [ ] Compact EntityCard to match IdeaCard density
  - Reduce padding from `p-3` to `px-3 py-2.5`
  - Title: `text-sm font-medium text-fg-primary line-clamp-1`
  - Description: `text-xs text-fg-muted line-clamp-1` (was `line-clamp-2`)
  - Meta row: inline, compact, `text-xs text-fg-muted`
  - Add proper focus-visible outline
  - Add `aria-label`
- [ ] Constrain list max-width on desktop when no detail panel
  - Add `max-w-2xl` to the entity list when detail panel is not shown
- [ ] Replace filter chips with a compact dropdown on mobile
  - Keep chips on desktop, use `<select>` on mobile to avoid 2-row wrapping
- [ ] Fix create form mobile layout
  - Stack type select and description vertically on mobile
  - Proper button sizing with `min-h-[44px]` touch targets
- [ ] Fix delete button visibility on touch/mobile
  - Always show delete on mobile (no hover gating)
  - Keep hover-reveal on desktop
- [ ] Lighten observation cards in detail panel
  - Remove individual borders, use simpler divider pattern
  - Reduce padding
  - Better visual grouping
- [ ] Improve visual hierarchy
  - Entity name more prominent, metadata more subdued
  - Observation content vs metadata distinction
  - Section headers consistent with app patterns
- [ ] Update Playwright screenshot tests with AFTER screenshots
- [ ] Verify no horizontal overflow on mobile

## Acceptance Criteria

- [ ] KnowledgePage uses only semantic Tailwind classes (no raw `var(--sam-*)`)
- [ ] Entity cards match the density/style of IdeaCard
- [ ] Filter area doesn't wrap to 2 rows on 375px mobile
- [ ] Create form is usable on mobile (fields stack properly)
- [ ] Delete buttons accessible on touch devices
- [ ] Desktop list has max-width constraint when no detail panel
- [ ] Existing Playwright tests pass
- [ ] No horizontal overflow at 375px
- [ ] Visual before/after screenshots demonstrate improvement
