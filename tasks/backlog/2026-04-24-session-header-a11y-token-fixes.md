# Session Header Accessibility and Design Token Fixes

> **Reconciliation 2026-10-05:** #2230 added a `sleeping` task status. SessionHeader's badge (`apps/web/src/components/project-message-view/SessionHeader.tsx:455-479`) gives it the same fallback style as `cancelled` (item #10), which uses an undefined token. Whoever fixes item #10 should cover `sleeping` too.

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** files are under `apps/web/src/components/project-message-view/`.
>   - #1: `bg-surface-default` is gone from the session header.
>   - #4: Retry/Fork and the details toggle moved to the tool rail; its buttons have focus rings
>     (`SessionToolRail.tsx:153,228,301`).
>   - #9: the `hasDetails` constant is gone.
>   - #11: `apps/web/tests/playwright/session-header-agent-info-audit.spec.ts` covers mobile and
>     desktop, with overflow checks and long-content cases.
> - **Still open:**
>   - #2/#3: undefined tokens `--sam-color-accent-tint` and `--sam-color-surface-hover`
>     (`SessionHeader.tsx:281,465-466`). The defined names are
>     `--sam-color-accent-primary-tint` and `--sam-color-bg-surface-hover`
>     (`packages/ui/src/tokens/theme.css:15,181`). Overlaps the repo-wide undefined-token sweep
>     owned by `tasks/backlog/2026-09-23-resource-sparkline-gap-marker-has-no-colour.md`.
>   - #6: copy success is not announced (`CopyableId.tsx` has no `aria-live` or label change).
>   - #7: the Details action sets `aria-expanded` but not `aria-controls`
>     (`SessionToolRail.tsx:167`).
>   - #8: the failed badge has no icon (`SessionHeader.tsx:477`).
>   - #10: `cancelled` has no distinct badge style.
>   - #12: `allowedHosts: true` in `apps/web/vite.config.ts:118` is still undocumented.
> - **Moot/dropped:** #5 (44px touch targets). Current guidance says not to demand larger touch
>   targets (`.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md:31,73`,
>   `apps/web/.claude/rules/17-ui-visual-testing.md:69`).

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
