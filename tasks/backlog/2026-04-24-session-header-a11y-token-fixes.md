# Session Header Accessibility and Design Token Fixes

**Created**: 2026-04-24
**Source**: Post-merge UI/UX specialist review + task-completion-validator of PR #804

## Problem

The session header enhancements (PR #804) shipped with several accessibility gaps and incorrect design system token references identified by the ui-ux-specialist review agent. The review completed after the PR was already merged.

## Issues to Fix

### HIGH — Design Token Fixes

1. **`bg-surface-default` → `bg-surface`** (SessionHeader.tsx line 47): `bg-surface-default` is not a defined Tailwind token. The correct class is `bg-surface`. Currently renders with no background (transparent fallback).

2. **Wrong CSS variable for in_progress badge** (line 337): `var(--sam-color-accent-tint)` should be `var(--sam-color-accent-primary-tint)`. The fallback `rgba(59, 130, 246, 0.1)` is blue but the design system accent is green. Use the Tailwind class `bg-accent-tint` instead.

3. **Wrong CSS variable for default badge** (line 338): `var(--sam-color-surface-hover)` should be `var(--sam-color-bg-surface-hover)`. Use the Tailwind class `bg-surface-hover` instead.

### HIGH — Accessibility

4. **Focus-visible rings on Retry/Fork buttons**: CopyableId already has focus-visible (added in commit 86269222), but Retry and Fork buttons (lines 242, 253) lack `focus-visible:outline` classes.

5. **Touch targets below 44px**: Retry/Fork buttons use `p-1.5` on 14px icons (~26px hit area). Add `min-h-[44px] min-w-[44px]` or increase padding.

6. **Copy success not announced to screen readers**: Add `aria-live="polite"` region or update button `aria-label` dynamically after copy.

### MEDIUM

7. **Missing `aria-controls` on expand toggle**: Toggle sets `aria-expanded` but no `aria-controls` pointing to the expanded panel's `id`.

8. **Failed status badge lacks icon**: `completed` has CheckCircle2 but `failed` has no icon — add XCircle or similar for non-color redundancy.

9. **`hasDetails` constant always `true`**: Dead conditional — remove the constant and the `{hasDetails && ...}` guards.

### LOW

10. **No handling for `cancelled` status in badge colors**: Falls through to default with no distinct visual treatment.

11. **Add Playwright visual audit spec for session header**: Rule 17 requires a dedicated local Playwright spec with mock data scenarios (normal, long IDs with full ULIDs, empty states) at mobile (375x667) and desktop (1280x800) viewports. Staging Playwright verification was done but no spec file was created.

12. **Document `allowedHosts: true` in vite.config.ts**: Added for Codespace port forwarding but lacks a comment explaining why. Add inline comment or revert if no longer needed.

## Acceptance Criteria

- [ ] All Tailwind token references match the design system (`bg-surface`, not `bg-surface-default`)
- [ ] All inline CSS variable references match defined tokens
- [ ] Retry/Fork buttons have focus-visible rings
- [ ] Touch targets meet 44px minimum on mobile
- [ ] Copy success is announced to screen readers
- [ ] Expand toggle has `aria-controls` pointing to panel `id`
- [ ] Failed status badge has a non-color indicator (icon)
- [ ] `hasDetails` constant removed, guards simplified
- [ ] Playwright visual audit spec added with long-ID mock data scenarios
- [ ] `allowedHosts: true` in vite.config.ts documented or reverted
