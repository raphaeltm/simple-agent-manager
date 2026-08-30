# Mandatory Playwright Visual Testing for UI Changes

## When This Applies

This rule applies whenever a PR modifies files in:

- `apps/web/` (control plane UI)
- `packages/ui/` (shared design system)
- `packages/terminal/` (terminal component)

## Requirement: Local Playwright Visual Audit

Before proceeding to PR review (Phase 5) or staging verification (Phase 6), you MUST run a local Playwright visual audit of every changed or new UI surface. This catches layout issues, overflow bugs, and style inconsistencies before they reach staging or production.

### What to Test

Run Playwright against the local Vite preview server with **mocked API data** covering these scenarios:

| Scenario               | What it catches                              | Example mock data                                     |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------- |
| **Normal data**        | Baseline rendering, spacing, alignment       | 3-5 items with typical titles and descriptions        |
| **Long text**          | Overflow, text wrapping, layout breaks       | Titles 200+ chars, descriptions 500+ chars, long URLs |
| **Empty states**       | Missing empty-state handling, broken layouts | Empty arrays, null descriptions, zero counts          |
| **Many items**         | Scroll behavior, pagination, performance     | 30+ items in lists                                    |
| **Error states**       | Error display, recovery UI                   | API 500s, timeouts, 404s                              |
| **Special characters** | XSS safety, encoding issues                  | Unicode, emoji, HTML entities, `<script>` tags        |
| **Single character**   | Minimum content handling                     | Single-letter titles, empty descriptions              |

### Viewport Requirements

Every changed surface must be screenshotted at **both**:

- **Mobile**: 375x667 (iPhone SE) — the narrowest supported viewport
- **Desktop**: 1280x800 — standard desktop viewport

### Screenshot Capture

1. Store screenshots in `.tmp/playwright-screenshots/` (gitignored)
2. Use descriptive filenames: `<component>-<scenario>-<viewport>.png`
   - Example: `task-list-long-text-mobile.png`, `task-detail-error-desktop.png`
3. Wait at least 500ms after navigation before capturing to allow render settling
4. Post desktop and mobile screenshots for every changed UI surface in a PR
   comment. Local screenshot paths alone are not review evidence because they
   disappear with the agent workspace.
5. Link the screenshot comment, or embed the image links, in the PR body's
   `UI Screenshot Evidence` section.

### Preflight Enforcement

The `scripts/quality/check-preflight-evidence.ts` checker enforces the UI evidence
requirement as a CI gate for PRs that check `ui-change` in Agent Preflight. The
`UI Screenshot Evidence` section must enumerate every changed surface under its own
`#### Surface: <name>` heading, and each surface block must carry a **desktop**
screenshot link and a **mobile** screenshot link (Markdown image, direct image URL,
or a GitHub `#issuecomment-…` URL), plus the surface's mock/stress data and its
screenshot quality review attestation. Global-only desktop/mobile links that are not
bound to an enumerated surface are rejected — a single link cannot satisfy multiple
changed surfaces. Keep this checker and this section aligned.

### What to Check in Screenshots

For each screenshot, verify:

1. **No horizontal overflow** — `document.documentElement.scrollWidth` must not exceed `window.innerWidth`
2. **No content clipping** — text, buttons, and interactive elements must be fully visible
3. **No off-screen elements** — nothing pushed beyond viewport edges by long content
4. **Proper text wrapping** — long titles/descriptions wrap cleanly, no single-word lines unless unavoidable
5. **Consistent spacing** — margins, padding, and gaps match the design system rhythm
6. **Interactive elements are reasonably clickable/tappable** — compact, information-dense controls are preferred; do NOT demand enlarged touch targets or mandate minimum pixel sizes
7. **Visual hierarchy** — headings, labels, and body text use the correct typography scale
8. **Dark mode compatibility** — if the app supports dark mode, screenshots should verify both themes or the active theme
9. **Empty state quality** — empty states show helpful messaging, not blank space or broken layouts

### How to Run

From the `apps/web/` directory:

```bash
# Build and run visual audit tests
npx playwright test --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
```

Or for a specific test file:

```bash
npx playwright test tests/playwright/<component>-audit.spec.ts
```

### Test File Pattern

Follow the established pattern from `apps/web/tests/playwright/ideas-ui-audit.spec.ts`:

```typescript
import { test, expect, type Page, type Route } from '@playwright/test';

// 1. Mock data factories with overrides
function makeItem(overrides: Partial<Item>) { ... }

// 2. Scenario datasets
const NORMAL_ITEMS = [ ... ];
const LONG_TEXT_ITEMS = [ ... ];
const MANY_ITEMS = Array.from({ length: 30 }, (_, i) => makeItem({ ... }));

// 3. Single API mock handler
async function setupApiMocks(page: Page, options: { ... }) {
  await page.route('**/api/**', async (route: Route) => { ... });
}

// 4. Screenshot helper
async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// 5. Mobile tests (default from config)
test.describe('Component — Mobile', () => {
  test('normal data', async ({ page }) => { ... });
  test('long text wraps correctly', async ({ page }) => { ... });
  test('empty state', async ({ page }) => { ... });
  test('many items', async ({ page }) => { ... });
  test('error state', async ({ page }) => { ... });
});

// 6. Desktop tests
test.describe('Component — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
  test('normal data', async ({ page }) => { ... });
  test('long text', async ({ page }) => { ... });
});
```

### Overflow Detection (Required)

Every test that renders dynamic content MUST include an overflow assertion:

```typescript
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > window.innerWidth
);
expect(overflow).toBe(false);
```

### When to Write New Tests vs. Run Existing

- **New component or page**: Write a new `<component>-audit.spec.ts` file following the pattern above
- **Modified existing component**: Run the existing audit test if one exists; add new scenarios if the change introduces new data shapes or layouts
- **Style-only change**: Run all existing audit tests for affected components to catch regressions

### Failure Blocks Merge

If any visual audit reveals:

- Horizontal overflow on mobile
- Clipped or off-screen content
- Broken layouts with edge-case data
- Style inconsistencies with the design system

You MUST fix the issue before proceeding. Do NOT defer visual bugs to a follow-up task.

### PR Evidence Gate

When a PR checks `ui-change` in Agent Preflight, CI requires a filled
`UI Screenshot Evidence` section in the PR body. The section must enumerate every
changed surface and, for each surface, include:

1. A `#### Surface: <name>` heading identifying the surface.
2. Desktop and mobile Playwright screenshot links for that surface (image link or
   PR comment `#issuecomment-…` URL).
3. The mock/edge-case data used to push that surface, not only happy-path data.
4. An explicit quality-control attestation that the surface's screenshots were
   reviewed for layout quality, overflow, clipping, readability, and responsive
   behavior, plus the result: either no visual issues found, or the issues found
   and fixed before handoff.

### Guided Flows Must Test the User Action

When a CLI, log stream, WebSocket, or other technical transport emits an
actionable URL, verification code, token, or confirmation:

1. Promote the actionable value into semantic native controls (for example, an
   `<a>` for opening a URL and a labeled button for copying a code). Do not make
   users select or interpret terminal/log output.
2. Keep the technical transport behind the product boundary unless raw terminal
   access is itself the feature.
3. Visual and behavioral tests must perform the primary action at mobile and
   desktop sizes. Rendering, screenshots, and overflow checks alone are
   insufficient; assert the link target, copy behavior, keyboard-accessible
   control, and failure feedback.
4. Staging validation must prove the actionable value came through the real
   integration, then exercise the native control that exposes it.

## A Layout Relationship Must Be Asserted As Measured Coordinates

When a change claims that two elements relate spatially — "the panel stops where the
rail starts", "the button sits left of the gutter", "the footer clears the composer" —
that claim must be asserted by **comparing measured coordinates**, not by a screenshot,
not by `toBeVisible()`, and not by reading back a value the component itself set.

```ts
// WEAK — passes for an element parked 400px below the fold
await expect(rail).toBeVisible();

// WEAK — reads back the width the component was told to render; says nothing
// about whether that width reserved anything for its siblings
expect(spacer.getBoundingClientRect().width).toBe(46);

// STRONG — the actual relationship, in page coordinates
const railBox = await rail.boundingBox();
const headerBox = await header.boundingBox();
expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(railBox!.x + 1);
```

### Why this rule exists

The session tool rail (PR "Surface session controls in a chat tool rail") reserved its
width with a sibling `<div style={{ width }}>`. The messages container is
`flex-col lg:flex-row` — **below `lg` it is a column**, where a sibling's width reserves
nothing on the cross axis. The chat column, and the absolutely-positioned header inside
it, stretched to the full viewport while the rail overlaid the right edge. Any header
content reaching that zone was pointer-blocked.

It survived a green suite, 36 passing Playwright assertions, and a screenshot review —
because the mock chip row happened to wrap before reaching the rail. Line-wrap luck, not
correctness. It surfaced the moment two coordinates were compared: header right edge
375px, rail left edge 330px.

**Responsive containers change layout *semantics*, not just sizes.** A guarantee that
holds in `flex-row` can evaporate in `flex-col` with nothing in the code to signal it.
Assert the relationship at every viewport in the project matrix.

## A Conditional Test Needs An Else Branch

A test whose assertions live inside `if (await x.isVisible())` reports green when the
condition is false — whether the feature works, is broken, or never rendered at all. The
guard must either be an assertion, or the `else` must fail or explicitly `test.skip()`
with a reason.

```ts
// BANNED — zero assertions execute when the button never appears
if (await scrollBtn.isVisible().catch(() => false)) {
  expect(...);
}

// CORRECT — make the precondition true, then assert unconditionally
await seedEnoughContentToScroll(page);
await scrollAwayFromBottom(page);
await expect(scrollBtn).toBeVisible();
expect(...);
```

The same PR shipped exactly this: a scroll-button collision check guarded on
`isVisible()`, where the four-message fixture mounted `alignToBottom` at the last item so
the button never rendered on any of the four viewport projects. The guard was permanently
false and the test executed **zero assertions** while reporting green. This is the
rule-62 family and the `.claude/rules/02` "absence of failures and absence of tests are
indistinguishable" failure mode, in test-body form.

Before merging a conditional assertion, ask: *under what fixture does this branch
actually run?* If you cannot name it, instrument the condition and measure it.

## Responsive / On-Demand Surfaces Must Be Proved Visible

When a user action opens a responsive surface (rail, drawer, popover, composer,
details panel), tests must prove the resulting surface is visible at the
viewport where the action is available. Do not rely on state-only assertions or
mobile-only inline panels when desktop CSS hides that panel.

Retained incident lesson (2026-08-25): desktop chat message comments regressed
because the message and selected-text `Comment` controls set draft state, but
the only composer lived in an inline panel hidden at `lg`. The action looked
clickable and the state updated, while users saw nothing. The fix restored an
on-demand desktop rail and added tests that click the real header, message-level,
and selected-text controls at 1280x800 and assert the rail/composer becomes
visible.

Required for any responsive/on-demand surface:

1. Assert the surface is hidden by default when that is part of the intended UX.
2. Click every public entry point that should open it, at the viewport where each
   entry point is rendered.
3. Assert the visible surface contains the active/draft state created by the
   action, not just that a boolean or ARIA attribute changed.
4. Include mobile and desktop screenshots when the surface changes form across
   breakpoints.

## Virtualized-List Scroll/Jump Features (jsdom Renders All Rows — Assert the Coordinate)

When a feature scrolls or jumps to a specific item in a **virtualized** list
(react-virtuoso, react-window, TanStack Virtual, etc.), the jsdom test mock has no
layout engine and typically renders **every** row. This masks two whole classes of
bug that only appear against a real virtual window:

1. **Coordinate-space mismatches.** The library's `scrollToIndex` may expect a
   0-based data-array index while your code holds an offset/absolute index (e.g.
   react-virtuoso's `firstItemIndex`-offset coordinate used for `itemContent`'s
   `index` arg). Passing the wrong coordinate is silently out-of-range → no scroll.
2. **"Highlight set on an unmounted row."** If the target row is virtualized-out and
   the scroll never lands, a class/state applied to that row never renders. A test
   that only asserts "the highlight class appears" PASSES anyway, because the mock
   rendered the row regardless of scroll.

This is exactly how the timeline jump-to-message shipped a dead click: the unit
mock rendered all rows and ignored the ref, so `scrollToIndex` was a no-op and the
highlight always attached in jsdom. See the retained incident lesson in this rule
(2026-07-03).

### Required for any scroll/jump-to-item feature

1. **The virtualization mock MUST expose the scroll method** (via
   `useImperativeHandle` on the forwarded ref) and capture its arguments. A mock
   that ignores the ref cannot test the jump.
2. **Assert the exact index/coordinate passed to `scrollToIndex`** — not just that
   a highlight/selection appeared. Place the target at a non-trivial position (not
   index 0, not the last item) so the correct value is unambiguously different from
   the buggy offset value (e.g. assert `index === 1` AND `index < 1000` to rule out
   a `firstItemIndex`-offset ~100000).
3. **Verify the assertion is discriminating**: confirm the test FAILS on the
   pre-fix (wrong-coordinate) code before relying on it.
4. **Staging-verify the scroll/jump in a real browser.** jsdom cannot prove a
   virtual-window scroll actually lands. The staging Playwright pass MUST click the
   real control and confirm the target scrolls into view / highlights (Rule 13).

## Integration with /do Workflow

This testing is triggered in **Phase 3 (Implementation)** of the `/do` workflow. See `.codex/prompts/do.md` Phase 3 for the exact integration point. The `/do` workflow will not proceed to Phase 4 if visual audit failures are unresolved.
