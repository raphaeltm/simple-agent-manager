# FailureCard uses an undefined `--sam-color-fg-secondary` token

## Problem

`apps/web/src/components/debug/FailureCard.tsx` (lines ~188 and ~247) sets
`color: 'var(--sam-color-fg-secondary)'`. No such token exists in
`packages/ui/src/tokens/` (only `--sam-color-fg-primary` and `--sam-color-fg-muted`), so the
declaration is invalid at computed-value time and the text inherits whatever colour its
parent has, rather than the intended secondary shade.

## Context

Found 2026-11-16 during Insights slice H2 (task 01M7K7EH5AW0WS77NP9CY4S8TT). The same
undefined token made the Admin Analytics chart category labels render black on dark panes;
that one was fixed in `apps/web/src/pages/admin-analytics/chartTokens.ts`.

## Acceptance Criteria

- [ ] FailureCard uses a defined token (`--sam-color-fg-muted` or `--sam-color-fg-primary`)
- [ ] Checked in both `sam` and `sam-light` themes for 4.5:1 contrast
- [ ] `grep -rn "fg-secondary)" apps/web/src packages/ui/src` finds no `var()` use of the undefined token
