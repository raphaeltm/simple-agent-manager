# Virtual scroll jump benchmark — virtuoso vs @tanstack/react-virtual

Throwaway spike (branch `sam/virtual-scroll-bench`). Not for merge to main —
remove the `/__bench/virtual-scroll` route + this folder before shipping any
production change.

## Question

Project chat scrolling jumps when a long conversation mixes **collapsed tool
cards (consistent height)** with **variable-height agent text**. Does switching
the virtualizer from `react-virtuoso` to `@tanstack/react-virtual` reduce it?

## Method

- Real component under test: production `AcpConversationItemView` (real
  react-markdown, real tool cards) rendered inside each virtualizer.
- Seeded stress dataset (`mock-data.ts`): ~62% collapsed tool cards, ~30%
  variable agent markdown (one-liners → long multi-paragraph w/ code fences),
  plus occasional user/thinking items.
- Virtuoso config **mirrors production** (`alignToBottom`, `followOutput`,
  `initialTopMostItemIndex`, `firstItemIndex`, `overscan`).
- TanStack config is best-practice bottom-anchored: dynamic `measureElement`
  (ResizeObserver), stable `getItemKey` (item id), `overscan: 12`, and
  **`anchorTo: 'end'`** — whose default `shouldAdjustScrollPositionOnItemSizeChange`
  SKIPS scroll correction during backward (upward) scroll.
- Playwright (`tests/playwright/virtual-scroll-bench.spec.ts`) drives a scripted
  bottom→top scroll (80 steps) and measures, per library:
  - **totalJump** — cumulative involuntary content displacement of on-screen
    rows during the post-scroll settle window (no scroll commanded → any row
    movement is a visible jump). Primary, maps to "the text I'm reading jumps".
  - **cls** — browser Layout Instability score (independent; accounts for
    scroll, so scrollbar-only compensation is not penalized).
  - **fps** during traversal.

## Results (Desktop 1280×800, chromium)

| items | metric        | virtuoso | tanstack | delta        |
|-------|---------------|----------|----------|--------------|
| 1500  | totalJump px  | 41123    | 10106    | **75% less** |
| 1500  | maxStepJump px| 1727     | 454      | **74% less** |
| 1500  | CLS           | 1.29     | 0.00     | **100% less**|
| 1500  | fps           | 49.3     | 46.9     | ~same        |
| 3000  | totalJump px  | 53653    | 15708    | **71% less** |
| 3000  | maxStepJump px| 2247     | 656      | **71% less** |
| 3000  | CLS           | 0.79     | 0.00     | **100% less**|
| 3000  | fps           | 48.7     | 45.7     | ~same        |

## Takeaway

TanStack with `anchorTo: 'end'` removes ~71–75% of scroll jump and drops the
browser-measured layout instability to **zero**. Mechanism matches theory:
virtuoso corrects its height estimate in BOTH scroll directions; TanStack's
end-anchor skips correction while scrolling up, which is exactly when the jump
was worst. FPS is effectively unchanged.

Not a free drop-in swap — a real migration still needs: anchor-preserving
"load earlier" prepend (production uses `firstItemIndex`), `scrollToIndex`
coordinate mapping for the timeline jump-to-message, and follow-on-append wiring
so new agent output still sticks to the bottom. All tractable.
