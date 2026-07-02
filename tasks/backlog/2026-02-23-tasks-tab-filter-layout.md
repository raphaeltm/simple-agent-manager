# Fix Tasks Tab Vertical Filter Layout

**Created**: 2026-02-23
**Priority**: Medium
**Classification**: `ui-change`

## Context

The tasks tab on the projects page has filters (Status, Min Priority, Sort) that are stacked vertically, consuming excessive vertical space. They should be arranged horizontally in a compact toolbar-like layout.

## Root Cause

**File**: `apps/web/src/components/project/TaskFilters.tsx` (lines 31-34)

```typescript
display: 'grid',
gap: 'var(--sam-space-3)',
gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
```

The `minmax(180px, 1fr)` with `auto-fit` causes each filter to stack into its own row when the container width is less than `180px * 3 + gaps`. Each individual filter also has a `label` wrapper with `display: 'grid'` and internal vertical gap, further consuming space.

## Plan

Switch from CSS Grid to flexbox with horizontal preference, reduce minimum widths, and make labels inline or compact.

## Detailed Tasklist

- [ ] Read `apps/web/src/components/project/TaskFilters.tsx` to understand current layout
- [ ] Change the filter container from CSS Grid to flexbox with `flexDirection: 'row'` and `flexWrap: 'wrap'`
- [ ] Reduce minimum widths from 180px to something more compact (120-140px)
- [ ] Make filter labels more compact (consider inline labels or placeholder text)
- [ ] Ensure filters still wrap gracefully on very narrow screens (mobile)
- [ ] Run build: `pnpm --filter @simple-agent-manager/web build`
- [ ] Run typecheck: `pnpm typecheck`

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/components/project/TaskFilters.tsx` | Fix layout to horizontal flex |
