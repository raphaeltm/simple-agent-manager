# Notification UI — Accessibility & UX Follow-ups

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Filter tabs have tab semantics (`role="tablist"`, `role="tab"`, `aria-selected`,
>     `aria-controls`) and arrow-key navigation (PR #973;
>     `apps/web/src/components/NotificationCenter.tsx:257-300`).
>   - Dead code in `dismiss` removed (PR #1872; `apps/web/src/hooks/useNotifications.ts:142-164`).
> - **Still open:**
>   - `text-fg-secondary` at `NotificationCenter.tsx:496,619`. It is not a defined token
>     (`apps/web/src/app.css:28-30` defines only fg-primary, fg-muted and fg-on-accent), and it is
>     used in 24 `apps/web` files; the repo-wide sweep is owned by
>     `tasks/backlog/2026-09-23-resource-sparkline-gap-marker-has-no-colour.md`.
>   - Action buttons are still `opacity-0 group-hover:opacity-100` with no focus variant (`:561`).
>   - The group toggle has `aria-expanded` but no `aria-controls` (`:607-612`).
>   - The "Load more" label is unchanged (`:377,412`).
>   - The group badge is still `text-[9px]` at 14px (`:625`); tab badges are `text-[9px]` too
>     (`:295`).
>   - UI items carried over from the phase-1 follow-ups file (end of this file).

**Created**: 2026-03-16
**Source**: Late-arriving ui-ux-specialist review of PR #420 (merged)
**Priority**: High (accessibility gaps are WCAG failures)

## Problem Statement

Post-merge UI/UX review identified accessibility gaps in the NotificationCenter component that constitute WCAG 2.1 A/AA failures. These need to be addressed in a follow-up PR.

## Findings

### HIGH — `text-fg-secondary` is not a defined design token

**Location**: `apps/web/src/components/NotificationCenter.tsx` line 352
**Fix**: Replace `text-fg-secondary` with `text-fg-muted` (the correct semantic token for supporting context text).

### HIGH — Action buttons invisible on mobile and to keyboard users

**Location**: `apps/web/src/components/NotificationCenter.tsx` line 302
**Description**: Mark-as-read and Dismiss buttons use `opacity-0 group-hover:opacity-100`, making them permanently invisible on touch devices and to keyboard-only users (WCAG 2.1 SC 1.3.1 and 2.4.7).
**Fix**: Add `group-focus-within:opacity-100` alongside `group-hover:opacity-100`. On mobile, consider always showing the dismiss button.

### MEDIUM — Filter tabs lack ARIA tablist semantics

**Location**: `apps/web/src/components/NotificationCenter.tsx` lines 163–178
**Description**: All/Unread filter buttons are plain `button` elements without `role="tablist"`, `role="tab"`, or `aria-selected`. The shared `Tabs` component in `packages/ui/` already implements full ARIA tab pattern.
**Fix**: Add `role="tablist"` to container, `role="tab"` and `aria-selected` to buttons, implement ArrowLeft/ArrowRight keyboard navigation.

### MEDIUM — Group expanded content lacks `aria-controls` linkage

**Location**: `apps/web/src/components/NotificationCenter.tsx` NotificationGroup
**Description**: `aria-expanded` is set on the toggle button but there's no `aria-controls` pointing to the expanded content region.
**Fix**: Add stable `id` to expanded children wrapper, add `aria-controls={id}` to toggle button.

### MEDIUM — "Load more" button label unclear in grouped path

**Description**: Button says "Load more" inside grouped view, implying per-group loading. It actually loads globally.
**Fix**: Change label to "Load more notifications".

### LOW — Group unread badge below legibility threshold

**Description**: Badge uses `text-[9px]` and `min-w-[14px] h-[14px]`. Below WCAG AA contrast for normal text at that size.
**Fix**: Increase to `text-[10px]` and `min-w-[16px] h-[16px]` to match bell button badge pattern.

### LOW — Dead code in dismiss function

**Location**: `apps/web/src/hooks/useNotifications.ts` lines 105–108
**Description**: Second `setNotifications` call returns `prev` unchanged — no-op leftover from refactor.
**Fix**: Remove it.

## Acceptance Criteria

- [ ] `text-fg-secondary` replaced with valid design token
- [ ] Action buttons visible on keyboard focus (`group-focus-within:opacity-100`)
- [ ] Filter tabs have proper ARIA tablist/tab/aria-selected semantics
- [ ] Group toggle button has `aria-controls` linking to content region
- [ ] "Load more" button label clarified in grouped view
- [ ] Badge size meets legibility threshold
- [ ] Dead code removed from dismiss function

## Carried over 2026-09-30

From `2026-03-16-notification-system-phase1-followups` (removed from the backlog 2026-09-30; see git history), dissolved in the
2026-09-30 weekly queue audit:

- [ ] Focus trap in the notification panel. It renders `role="dialog"` without
      `useModalInteraction` (`apps/web/src/components/NotificationCenter.tsx:232-238`).
- [ ] An `aria-live` region that announces unread-count changes.
- [ ] A batch-dismiss endpoint. Only `POST /api/notifications/:id/dismiss` exists
      (`apps/api/src/routes/notifications.ts:163`).
