# Fix Admin Page Padding

**Created**: 2026-02-23
**Priority**: Low
**Classification**: `ui-change`

## Context

The admin page (user approval page) lacks padding. It's the only page that doesn't use the `PageLayout` component, resulting in no horizontal/vertical padding, no max-width constraint, and no responsive layout management.

## Root Cause

**File**: `apps/web/src/pages/Admin.tsx` (line 73-75)

```tsx
return (
  <div>
    <div style={{ marginBottom: 'var(--sam-space-6)' }}>
```

All other pages use `PageLayout`:
- Dashboard: `<PageLayout title="Simple Agent Manager" maxWidth="xl" headerRight={<UserMenu />}>`
- Projects: `<PageLayout title="Projects" maxWidth="xl" headerRight={<UserMenu />}>`
- Settings: `<PageLayout title="Settings" maxWidth="xl" headerRight={<UserMenu />}>`

`PageLayout` (from `packages/ui/src/primitives/PageLayout.tsx`) provides:
- Vertical padding: `var(--sam-space-8)`
- Horizontal padding: `clamp(var(--sam-space-3), 3vw, var(--sam-space-4))`
- Max-width constraint
- Centering

## Plan

Wrap the Admin page content with `PageLayout` like every other page.

## Detailed Tasklist

- [ ] Read `apps/web/src/pages/Admin.tsx` to understand current structure
- [ ] Wrap the page content with `<PageLayout title="Admin" maxWidth="xl" headerRight={<UserMenu />}>`
- [ ] Remove the bare `<div>` wrapper
- [ ] Import `PageLayout` and `UserMenu` if not already imported
- [ ] Verify visual consistency with other pages
- [ ] Run build: `pnpm --filter @simple-agent-manager/web build`
- [ ] Run typecheck: `pnpm typecheck`

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/pages/Admin.tsx` | Wrap with PageLayout |
