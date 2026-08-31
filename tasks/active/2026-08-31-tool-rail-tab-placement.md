# Session tool rail — tab placement and elevation

Design-review PR. **Not for merge as-is** — it carries a review knob that must be removed
once a placement is chosen.

## Problem

Raphaël reported two defects in the shipped rail (PR #1976), from mobile screenshots:

1. **Where the tab sits.** The collapsed pull-tab lands inside the floating header.
2. **How the shadows land.** The elevations read as incoherent.

Both were confirmed against the code, and both are worse than "looks off".

### 1. The tab collides with the header by construction

`SessionToolRail.tsx` anchored the tab `absolute top-3` — 12px from the top of the messages
container. `FloatingHeader.tsx:66` is `absolute top-0 left-0 right-0 z-10` in that same
container and 150–210px tall. The tab was inside the header's band on **every session**, not
in an edge case.

Measured, via a new assertion in the audit spec:

| anchor | overlap (short header) | overlap (tall header) |
| --- | --- | --- |
| `top` (shipped) | **52px** | **72px** |
| `center` | 0px | 0px |
| `lower` | 0px | 0px |

Identical in both themes at both viewports. The overlap **grows with header height**, so the
shipped placement was anchored against a moving target.

### 2. The elevations asserted a relationship that does not exist

Three hand-rolled shadows, all hardcoded black, none tokenized:

```
tab:            -2px 0 12px rgba(0,0,0,0.28)
rail (labels):  -8px 0 32px rgba(0,0,0,0.55)
rail (icons):   -4px 0 24px rgba(0,0,0,0.34)
```

Two problems. First, **icons mode does not overlay anything** — the rail owns a layout slot
and pushes the conversation — yet it cast a 24px shadow. Second, the design system's
shadows are per-theme (`rgba(16,40,28,0.12)` in light vs `rgba(0,0,0,0.4)` in dark); a fixed
`0.34` black is roughly 3x the light-theme weight, which is why the rail read as the
heaviest edge on screen in light mode.

The original code carried a comment justifying the hand-roll — "the design-system shadow
tokens (all downward-casting) do not apply". The observation was right; the conclusion was
not. The fix is a left-cast token, not an untokenized fourth elevation.

## Changes

- New `--sam-shadow-rail-tab` / `--sam-shadow-rail-overlay` tokens, per theme, in
  `packages/ui/src/tokens/theme.css`.
- Elevation only where one is true: the collapsed tab (floats) and the mobile labels rail
  (overlays) keep a shadow; icons mode and desktop labels get `none` and rely on the
  hairline border.
- `RailTabAnchor` with three placements; default `center`.
- The bar's top segment now reads as a **tab that flows into the bar**: the assembly's outer
  corner is rounded (`rounded-tl-lg`, clipping the segment) while the seam between tab and
  bar is a hard square edge, with a lifted `--sam-chrome-accent-active-subtle` background
  separating them without a second border.
- Comparison matrix in the audit spec: 3 anchors x 3 modes x 2 themes x 2 viewports, plus
  the overlap assertion the original audit lacked.

## Why the original audit missed it

It asserted the tab was `toBeVisible()`. It always was — an element half-buried under the
header is still "visible" to Playwright. Nothing asserted the tab did not *overlap* the
header. Same class as the other failures on #1976: an assertion that cannot observe the
defect it exists to catch. `tabHeaderOverlap()` is the missing measurement.

## Review knob — MUST be removed before merge

`useSessionTools.readReviewAnchor()` reads `sam-session-tool-tab-anchor` from localStorage so
the matrix can drive placement on the real chat surface. It has to be storage rather than a
prop because the collision under comparison is with the floating header, so the variants must
render in the real page, and a test cannot set a React prop that deep.

Once a placement is chosen: delete `readReviewAnchor`, `TAB_ANCHOR_REVIEW_KEY`, the
`tabAnchor` result field, `RailTabAnchor`, `RAIL_TAB_ANCHORS`, `RAIL_TAB_ANCHOR_STYLE`, the
`anchor` mock option and the comparison matrix; inline the winning placement.

## Open question for review

`below-header` was considered and deliberately not built: it couples the tab to a header
height that changes when chips wrap or Details expands, and needs a `min(headerHeight, 45%)`
clamp to stop the tab being pushed off-screen. Anchoring away from the header deletes that
failure mode rather than managing it. Worth building if neither `center` nor `lower` is
right.

## Acceptance

- [x] Overlap measured per anchor, both themes, both viewports
- [x] Tab/bar seam is square, outer corner rounded
- [x] Shadows tokenized and applied only where the element floats
- [x] 3592 unit tests pass, 0 collection errors; lint 0 errors; typecheck clean
- [ ] Placement chosen by Raphaël
- [ ] Review knob removed
- [ ] Staging verification (deferred — not merging yet)

## Workspace link removed (Raphaël, 2026-08-31)

> "Workspaces are kind of an implementation detail at this point. I don't think users
> should actually have any direct access to them. The page still exists for debugging
> purposes, but we shouldn't link to it."

Removed the `workspace` tool from the rail. Because it was the only action that navigated
rather than invoking a handler, three things became dead code and went with it (CLAUDE.md,
no dead code):

- `SessionToolAction.href`
- the `<a>` branch in `RailAction` — every remaining tool is a `<button>`
- the `ExternalLink` import and the no-op `case 'workspace'` in `selectTool`

`SessionToolId` loses `'workspace'`, so the exhaustiveness check on `selectTool` proves at
compile time that nothing still dispatches it.

### Tests

- `session-header.test.tsx` asserted the control was PRESENT. Inverted, with a liveness
  assertion beside it — "no workspace control" is also satisfied by a header that rendered
  nothing.
- The audit's "Workspace is a real link" test became "the rail offers no route into the
  workspace view". It asserts the old testid is gone AND that no anchor anywhere in the
  rail carries a `/workspaces/` href, so a rename cannot slip past it.
- Group-assignment and accessible-name fixtures updated.

### Still linked, needs a decision

`SessionHeaderInfrastructure.tsx:51` links the workspace name inside the **Details** panel
(the Infrastructure block, alongside VM size and node). That panel is the diagnostic
surface, so it is the one place a link is arguably consistent with "the page exists for
debugging" — but it is still direct user access, which the instruction rules out. Left in
place pending Raphaël's call; removing it is a one-line change that leaves the workspace
name as plain text.
