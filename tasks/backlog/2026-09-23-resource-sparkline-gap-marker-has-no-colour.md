# ResourceSparkline gap/counter-reset markers draw no line

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
