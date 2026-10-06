# Horizontal Overflow Inside `overflow-x-hidden` Is Invisible to Document-Level Checks

## When This Applies

Any UI work in `apps/web/`, `packages/ui/`, or `packages/terminal/`, and any test
that claims to verify "no horizontal overflow".

## Why This Rule Exists

The Triggers page rendered **768px wide inside a 375px viewport** in production.
The description and every card's action buttons were sheared off the right edge
with no way to scroll to them.

`triggers-ui-audit.spec.ts` had **25 green `assertNoOverflow` assertions** the
whole time. The helper only checked:

```ts
document.documentElement.scrollWidth > window.innerWidth;
```

`AppShell` sets `overflow-x-hidden` on `<main>` and `Project.tsx` repeats it on
its page wrapper. Overflow inside those is **clipped, not propagated** — so
`documentElement.scrollWidth` never grows and the assertion is structurally
incapable of seeing the bug. The check wasn't weak; it was measuring the wrong
thing. ~40 audit specs shared that blind spot.

## Class of Bug

**A guard that cannot observe the failure it claims to prevent.** The test is
green, CI is green, and the feature is visibly broken. It is the layout twin of
the source-contract test ban in rule 02: proving code is _present_ rather than
that it _works_.

The specific layout trap that produced it is worth knowing on its own:

1. A page root inside a **column** flex container using `mx-auto`. Auto
   cross-axis margins **disable `align-items: stretch`**, so the item falls back
   to fit-content sizing.
2. Flex items default to `min-width: auto`, which floors that at the subtree's
   **min-content** width.
3. Tailwind `truncate` sets `white-space: nowrap`, whose min-content
   contribution is the **entire untruncated string**.

So one long name in one `truncate` heading can drag a whole page past the
viewport — and `overflow-x-hidden` then hides the evidence.

## Hard Requirements

1. **Never assert "no overflow" using only `documentElement.scrollWidth`.** Use
   `assertNoOverflow` from `apps/web/tests/playwright/audit-helpers.ts`, which
   now also runs `assertNoClippedOverflow`. That walks the DOM for any element
   which clips horizontally (`overflow-x` resolved to `hidden`/`clip`) whose
   content is wider than its box.

2. **Deliberate clipping must be declared, not inferred.** The detector already
   excludes `text-overflow: ellipsis`, real scrollers (`auto`/`scroll`), sub-4px
   `sr-only` boxes, and native `<input>`/`<select>`. Anything else that is
   legitimately wider than its box — a carousel, a sliding panel — must carry
   `data-intentional-clip` with a comment saying why. An explicit opt-out beats a
   silent blind spot: the next reader can see the decision.

3. **A page root must not be sized by its own content.** Inside the project
   `<Outlet/>` wrapper (a column flex container), page roots use
   `w-full min-w-0`. `mx-auto` alone is not enough and actively causes this bug.

4. **Prefer wrapping to `truncate` for primary content on mobile.** A truncated
   name is unreadable on a 375px screen, and `truncate` doubles as a min-content
   inflator. Use `line-clamp-N` + `break-words`, and keep `truncate` for genuinely
   secondary, space-constrained chips.

5. **`line-clamp` does not protect against an unbreakable token.** A long URL in
   a clamped paragraph is sheared off horizontally with no ellipsis. Pair
   `line-clamp-N` with `break-words` wherever the text is user- or
   agent-supplied.

## Required Tests

- Any new or changed UI surface must call `assertNoOverflow` at mobile (375px)
  **and** desktop, with data that includes a long unbroken name and a long URL.
- A layout fix of this class needs an assertion on the **page root's measured
  width** (`root.getBoundingClientRect().width <= window.innerWidth`), not only
  the document-level check — that is the discriminating assertion.
- Prove the guard is discriminating: it MUST fail on the pre-fix build. Verify
  that once before relying on it.

## Quick Compliance Check

- [ ] Overflow assertions go through `assertNoOverflow` (which includes the
      clipped-overflow walk), never a hand-rolled `documentElement` check
- [ ] Every intentionally-clipping container carries `data-intentional-clip` + a
      reason
- [ ] Page roots inside the project Outlet wrapper have `w-full min-w-0`
- [ ] Primary names wrap (`line-clamp` + `break-words`) rather than `truncate`
- [ ] The new guard was verified to fail on the pre-fix build

## References

- Implementation: `apps/web/tests/playwright/audit-helpers.ts`
  (`assertNoClippedOverflow`)
- `.claude/rules/17-ui-visual-testing.md` — the mobile/desktop visual audit
- `.claude/rules/04-ui-standards.md` — mobile-first layout requirements
- `.claude/rules/02-quality-gates.md` — a test that cannot observe the failure is
  the layout analogue of a source-contract test
