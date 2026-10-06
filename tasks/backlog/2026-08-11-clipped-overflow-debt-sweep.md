# Burn down clipped-overflow debt, then promote the guard to blocking everywhere

## Problem

`assertNoClippedOverflow` (added 2026-08-11 with the trigger-page mobile fix,
branch `sam/see-trigger-page-goes-06qjzh`) detects horizontal overflow that the
old `documentElement.scrollWidth` check is structurally incapable of seeing:
content clipped by an ancestor's `overflow-x-hidden`, which the user experiences
as content sheared off the right edge with no way to scroll to it.

A full 3268-test Playwright sweep found this bug class already present on **11
surfaces beyond the triggers page**. Those are real user-visible clipping, not
detector noise — the false positives found in the same sweep (the two nav
carousels and the react-flow canvas) were separately tagged
`data-intentional-clip`.

Because fixing 11 surfaces is out of scope for the trigger fix, the guard ships
**advisory by default** (`reportClippedOverflow`, called from `assertNoOverflow`,
prints offenders) and **blocking on the trigger surfaces**
(`assertNoClippedOverflow`, called explicitly by `triggers-ui-audit.spec.ts`).
This matches the repo's progressive quality-tool rollout policy.

## Known offenders (from the 2026-08-11 sweep)

| Spec                                     | Clipped element                                         | Note                                                                                   |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `settings-vultr-credential-audit`        | `<main class="sam-main-content …overflow-x-hidden">`    | Settings breadcrumb/content                                                            |
| `settings-upcloud-credential-audit`      | same                                                    |                                                                                        |
| `settings-infomaniak-credential-audit`   | same                                                    |                                                                                        |
| `settings-digitalocean-credential-audit` | same                                                    |                                                                                        |
| `project-settings-subpages-audit`        | `<div class="min-h-screen min-w-0 overflow-x-hidden…">` | Project.tsx wrapper — same shape as the triggers bug, with a long project name         |
| `deployment-control-surface-audit`       | same                                                    |                                                                                        |
| `slice-e-theme-audit`                    | same                                                    | Agent Context page                                                                     |
| `skills-ui-audit`                        | `<p class="…line-clamp-2 text-xs…">`                    | Same `line-clamp` + unbreakable-token bug fixed in `TriggerCard` — needs `break-words` |
| `project-chat-composer-audit`            | `<div class="mb-3 overflow-hidden rounded-lg…">`        | Composer wizard step container; check whether it is an intentional slide               |
| `credential-health-audit`                | `<nav class="flex-1 overflow-hidden relative">`         | Should be covered by the `data-intentional-clip` tag on MobileNavDrawer — re-verify    |
| `portal-overlay-audit`                   | react-flow + nav                                        | Should be covered by the new tags — re-verify                                          |

Reproduce the current list:

```bash
cd apps/web
PLAYWRIGHT_BASE_URL=http://localhost:4173 npx playwright test <spec> --reporter=list 2>&1 | grep -a "clipped-overflow" -A 5
```

## Likely root cause for the `min-h-screen … overflow-x-hidden` group

Identical to the triggers bug (see
`.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`): a page
root using `mx-auto` inside the `Project.tsx` column-flex `<Outlet/>` wrapper
loses `align-items: stretch`, `min-width: auto` floors it at min-content, and a
`truncate` heading makes min-content the full untruncated string. `Project.tsx`
now carries a `[&>*]:max-w-full` guard, so any remaining offender in this group
is either a page that renders outside that wrapper or a different inflator —
measure the page root width before assuming.

## Acceptance Criteria

- [ ] Each surface above is either fixed or explicitly tagged
      `data-intentional-clip` with a written reason
- [ ] Each fix has a discriminating regression assertion on the page root's
      measured width (`root.getBoundingClientRect().width <= window.innerWidth`)
- [ ] `assertNoOverflow` is switched from `reportClippedOverflow` to
      `assertNoClippedOverflow` (blocking for every spec)
- [ ] The advisory `reportClippedOverflow` helper is removed once nothing needs it
- [ ] Rule 56 updated to drop the rollout note once the guard is blocking
