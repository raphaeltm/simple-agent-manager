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
4. **One live blur at a time.** `.sam-glass-live` only on a single overlay (drawer, sheet, popover). Never on regular panes, never on several stacked panes. Several blurred panes made Chrome on macOS flicker the whole page.
5. **No heavy backgrounds behind panes**: no canvas, tile grids, 3D transforms or large masked layers under app screens. The void is plain gradients.
6. **Person colours mean who, never state** (`--sam-person-*`). Amber (`--sam-color-warning`) only means waiting on you. Green means working or primary.
7. **44px touch targets on mobile**, even for small avatars and icons. Counts belong in the `aria-label`.
8. **Use tokens, never raw colours.** New values go in `packages/ui/src/tokens/sam-glass.css` or `glass.css`, in both themes, with contrast checked (4.5:1 text, 3:1 controls and focus).

## Verify

Check both themes (`data-ui-theme="sam"` and `"sam-light"`) and a mobile viewport, as `04-ui-standards.md` requires. Look for: text contrast on panes, panes merging into each other, more than one blurred element, faded avatars.
