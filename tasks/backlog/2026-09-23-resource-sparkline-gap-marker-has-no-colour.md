# Undefined --sam-color-* tokens in apps/web (was: ResourceSparkline gap marker has no colour)

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** PR #2185 (`2075aa074`) replaced the sparkline with the uPlot timeline in
>   `apps/web/src/components/chat/resource-timeline/`. `--sam-color-border-strong` no longer appears
>   anywhere; gaps now break the line (`resource-timeline/resource-source.ts:215-245`, covered by
>   `resource-source.test.ts` and `time-axis.test.ts`); and the guide
>   `apps/www/src/content/docs/docs/guides/session-resources.md:138-141,269` was rewritten to match.
> - **Still open:** acceptance criterion 3, the undefined-token sweep. None of these is defined in
>   `packages/ui/src/tokens/theme.css`:
>   - `--sam-color-fg-secondary`, no fallback: `apps/web/src/components/debug/FailureCard.tsx:173,214`
>     and `apps/web/src/pages/admin-analytics/chartTokens.ts:16`.
>   - `--sam-color-surface-hover`, no fallback:
>     `apps/web/src/components/project-message-view/SessionHeader.tsx:466` (the defined token is
>     `--sam-color-bg-surface-hover`).
>   - `--sam-color-accent-tint`, hardcoded blue fallback: `SessionHeader.tsx:281,465` (the defined
>     token is `--sam-color-accent-primary-tint`).
>   - `--sam-color-accent`, with fallback: `apps/web/src/app.css:180`.
>   - The Tailwind class `text-fg-secondary` maps to no defined token (`app.css:27-29` defines only
>     `fg-primary`, `fg-muted` and `fg-on-accent`) and is used in 24 apps/web files
>     (NotificationCenter, SessionItem, ChatInput, SessionHeader, admin charts, ...).
> - **Moot/dropped:** criteria 1, 2 and 4 (marker token, painted-marker test, docs screenshot and
>   guide wording). The marker no longer exists, and #2185 refreshed the docs.

## Problem

`apps/web/src/components/chat/SessionResourceHistoryDrawer.tsx:184` strokes the
gap / counter-reset marker with `var(--sam-color-border-strong)`. That custom
property is not defined anywhere — it is absent from
`packages/ui/src/tokens/theme.css` and every other token file, and this is its
only reference in the repository:

```
$ grep -rn "sam-color-border-strong" packages/ui/src/tokens apps/web/src
apps/web/src/components/chat/SessionResourceHistoryDrawer.tsx:184
```

The `stroke` therefore resolves to an invalid value and the line is not painted.
An OOM sample still gets its amber dashed line (that branch uses
`--sam-color-warning`, which exists), but a **gap** or **counter reset** renders
as a bare grey dot near the bottom axis with nothing connecting it to the chart.

## Why it matters

The legend in the same component tells the user to look for "Dashed markers:
gaps, counter resets, or OOM samples", so the chart promises an affordance it
does not draw for two of the three cases. A gap is not a period of zero usage —
it is missing data — so a reader who cannot see the marker will read a flat line
across it as "the agent was idle". That is the exact misreading the marker
exists to prevent.

## Evidence

Captured 2026-09-23 while producing the docs screenshot
`apps/www/public/images/docs/session-resources-drawer.png` (Playwright,
`docs-screenshots-sessions.spec.ts`, mock detail chunk with `gap: true` at
sample 28): the grey dot is present, the vertical line is not.

## Acceptance criteria

- [ ] The gap / counter-reset marker uses a token that exists (a neutral border
      or muted-foreground token), so the dashed line is visible in both themes.
- [ ] A test asserts the marker line is painted for a sample with `gap: true` —
      proven discriminating by removing the stroke and watching it redden.
- [ ] No other live reference to an undefined `--sam-color-*` custom property
      remains in `apps/web/src` (grep as part of the fix).
- [ ] If the fix changes the drawer's appearance, re-run
      `DOCS_SHOTS=1 npx playwright test docs-screenshots-sessions` and commit the
      refreshed docs image. Three places in
      `apps/www/src/content/docs/docs/guides/session-resources.md` describe the marker
      as it renders *today* and must be updated together, or the guide half-reverts:
      the chart-legend bullet under "The detail timeline", the "Gaps and resets"
      section, and the Troubleshooting row about a long flat stretch.
