# Admin shell clips a 437px element at narrow widths

## Problem

On every `/admin/*` page at 375px and 320px, the Playwright clipped-overflow detector
(`findClippedOverflow` in `apps/web/tests/playwright/audit-helpers.ts`) reports:

```
<main class="sam-main-content flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col ">
content 437px clipped to 375px — "AdminUsersIntegrationsCredentialsInfrast"
```

`<main>` has `overflow-x-hidden`, so something inside the admin shell is 437px wide and part of it
is invisible to the user, with no way to scroll to it. The admin `Tabs` strip already scrolls in
its own container (`packages/ui/src/components/Tabs.tsx`), so the culprit is not obviously the tab
row; it reproduces with empty data, so it is not a list item.

## Context

Found 2026-10-03 while adding the Admin → Storage "Recover space" dialog (branch
`sam/admin-wall-recovery-control`). It appears in every existing `admin-storage-audit.spec.ts`
case, before any dialog opens. That spec uses the advisory page-level check for this reason; the
new dialog uses a blocking dialog-scoped containment check instead.

## Acceptance Criteria

- [ ] Identify the 437px element on `/admin/storage` at 375px (log every descendant of `<main>` whose
      right edge passes `main`'s right edge).
- [ ] Fix it so nothing in the admin shell is clipped at 320px and 375px.
- [ ] Switch `admin-storage-audit.spec.ts` (and other admin specs) to the blocking
      `assertNoClippedOverflow` once the page passes.
