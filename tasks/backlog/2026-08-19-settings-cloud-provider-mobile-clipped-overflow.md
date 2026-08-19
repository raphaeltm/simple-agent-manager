# Settings cloud-provider page has clipped horizontal overflow at 375px

- **Discovered**: 2026-08-19, during Wave 4 consolidated staging validation
  (SAM task `01M0C2TF4KWTEMQBT1KB0VCFHC`)
- **Severity**: Low (5px, content still readable; no functional loss observed)
- **Status**: PRE-EXISTING — not introduced by the UI performance program

## Problem

At a 375px viewport on staging, `/settings/cloud-provider` renders content wider
than the viewport. The overflow is **clipped** by
`<main class="sam-main-content ... overflow-x-hidden">`, so
`document.documentElement.scrollWidth` never grows and a document-level overflow
check reports clean. This is exactly the blind spot described in
`.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`.

Measured (Playwright, Chromium, viewport 375x667):

```
main.sam-main-content   scrollWidth=380  clientWidth=375   (+5px)
div.grid.gap-4.mt-4     scrollWidth=368  clientWidth=351   (+17px)
section.glass-surface   left=12  right=380  width=368
```

The offending elements are the `section.glass-surface.rounded-lg.p-4` provider
cards in `apps/web/src/pages/SettingsCloudProvider.tsx` (Hetzner, Scaleway,
Vultr, Infomaniak, ...). Their right edge lands at 380px in a 375px viewport.

`/settings/advanced` showed a larger transient reading (`scrollWidth=563`) during
one navigation but measured clean when re-tested after settling — likely a
pre-settle layout frame. Worth confirming while fixing the above.

## NOT a bug (checked and dismissed)

The settings tab strip also extends past the viewport, but that is a deliberate
horizontally-scrollable tab bar and it works correctly:

```
div.flex.overflow-x-auto.snap-x.snap-mandatory   scrollWidth=763  clientWidth=349  overflowX=auto
scrollIntoView on the last tab ("API Tokens") -> left=260 right=362 (fully on screen)
```

It has an intentional right-edge gradient fade affordance. Every tab is
reachable. Do not "fix" this by constraining the strip.

Per rule 56 it should still carry a `data-intentional-clip` marker (with a
reason) on the clipping container so future audits do not re-flag it.

## Evidence it is pre-existing

None of the seven UI-performance commits touched the file that renders these
cards:

```
git log --oneline -1 -- apps/web/src/pages/SettingsCloudProvider.tsx
  b012fb838 feat: add DigitalOcean cloud provider and Block Storage (#1670)
```

and for each of `cb4f53762 1197facfc 1ef54144c 694479f97 530f8e9d6 f5f33559b
f66f5d91f`, `git show --stat --name-only` contains zero hits for
`SettingsCloudProvider.tsx`.

`Settings.tsx` WAS touched by `f66f5d91f` (item F), but that diff is purely
data-fetching (`useState`/`useEffect` -> `useCredentials` TanStack hook, plus a
memoized `SettingsContext` value). It contains **no** `className`, grid, padding,
or width change — verified by grepping the diff for
`className|grid|max-w|p-4|mx-auto|gap-`, which returns nothing.

## Acceptance criteria

- [ ] `/settings/cloud-provider` has zero clipped horizontal overflow at 375px
- [ ] `/settings/advanced` confirmed clean at 375px, including during load
- [ ] The scrollable tab strip carries `data-intentional-clip` + a reason comment
- [ ] A Playwright audit asserts the page-root measured width
      (`root.getBoundingClientRect().width <= window.innerWidth`), not only the
      document-level check — per rule 56 the document check cannot see this
- [ ] The new assertion is verified discriminating (fails on the pre-fix build)

## References

- `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`
- `.claude/rules/17-ui-visual-testing.md`
- `apps/web/tests/playwright/audit-helpers.ts` (`assertNoClippedOverflow`)
