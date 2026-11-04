---
paths:
  - 'apps/web/**'
  - 'packages/ui/**'
---

# SAM Glass

Every new or changed screen in the app follows SAM Glass. Full guide: `docs/guides/sam-glass-design-system.md`. For building a page or component, load the `sam-glass` skill.

## Must

1. **One void per screen**, on the app shell (`.sam-void`). Nothing sits on it directly except panes.
2. **Surfaces are glass; elements are solid.** Only panes (`.sam-glass .sam-glass-rim`, plus `--slab` / `--quiet`) are translucent. Avatars, buttons, chips, counts, switches and inputs are never translucent or faded. Inputs are wells (`.sam-well`); secondary controls are raised (`.sam-raised`).
3. **Gaps between panes**: 16px frame, `--sam-space-gutter` (14px) between panes. Do not merge columns with borders.
4. **Panes are frosted, once.** Every pane blurs the void behind it (`packages/ui/src/tokens/sam-glass.css`), so the void's edge glow shows through, blurred. A pane inside a pane does not blur again, and nothing inside a pane adds its own `backdrop-blur`; only an overlay laid over content (`.sam-glass-live`: drawer, sheet, popover) blurs on top. Keep pane fills low enough that the glow shows, and check text stays 4.5:1 where the glow is brightest. The pane blur lives on `::after`: never put `backdrop-filter`, `filter` or `transform` on a pane element itself, because that makes it the containing block for `position: fixed` children and traps every non-portaled dialog inside the pane.
5. **No heavy or moving backgrounds behind panes**: no canvas, tile grids, 3D transforms, animation or large masked layers under app screens. The void is plain static gradients; that is what keeps several blurred panes from flickering in Chrome on macOS.
6. **Person colours mean who, never state** (`--sam-person-*`). Amber (`--sam-color-warning`) only means waiting on you. Green means working or primary.
7. **44px touch targets on mobile**, even for small avatars and icons. Counts belong in the `aria-label`.
8. **Use tokens, never raw colours.** New values go in `packages/ui/src/tokens/sam-glass.css` or `glass.css`, in both themes, with contrast checked (4.5:1 text, 3:1 controls and focus).

## Verify

Check both themes (`data-ui-theme="sam"` and `"sam-light"`) and a mobile viewport, as `04-ui-standards.md` requires. Look for: the edge glow visible through the panes, text contrast on panes where the glow is brightest, panes merging into each other, a blur nested inside a blurred pane, faded avatars.
