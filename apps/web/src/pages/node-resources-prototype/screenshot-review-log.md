# Screenshot → review → fix log (node resource concepts)

## Iteration 1 — findings (from opening the images, not from the green test run)

1. **Boards were cropped.** Viewport height 3400 (mobile) / 2000 (desktop) is shorter
   than the scroll container's content, and the document cannot grow (html/body/#root
   are `overflow:hidden` at >=768px), so `page.screenshot()` silently cut nodes 5 and 6
   out of EVERY capture. The tests were green throughout.
   → Fix: measure `[data-prototype]`.scrollHeight after load and resize the viewport to it.
2. **vCPU readout had no unit** — "4.2 of 16" where RAM/disk said "7.9 GB of 31.5 GB".
3. **A 100%-full node rendered in the palest green.** The rails assigned ramp step 0
   (lightest) to tenant 0, so the exclusive node's full bars looked airy and friendly
   while the readout beside them said 100% in danger red. Mark and text disagreed.
   → Fix: assign from the canonical hue and alternate outward, so one tenant gets the
     saturated base hue and adjacent segments get maximum lightness separation.
4. **Sub-1% tenants drew as 1px hairlines** that read as dividers rather than data
   (disk rail on the cx53: three tenants at 0.56% each).
   → Fix: 3px minimum rendered segment.
5. **"Segments run left to right, light to dark…" printed on single-workspace nodes**,
   where there is nothing to order — and it became untrue after fix 3.
6. **`exclusiveNode` was invisible in concept A.** The ccx33 showed 100%/100%/100% with
   no hint that it refuses co-tenants by policy rather than by arithmetic.

## Iteration 2 — findings

Concept A fixes from iteration 1 applied; B, C, D reviewed for the first time.

7. **Concept B showed a physically impossible number.** The "peak" tick summed every
   tenant's peak, so the saturated cx43 read "peak 14.8 vCPU" on an 8-vCPU host and the
   tick pinned at 100%. Per-tenant peaks do not co-occur, so their sum is not a node
   peak. Means DO sum correctly; peaks do not.
   → Fix: the tick now shows the node's OWN observed utilisation from
     `node.lastMetrics` (the same field MiniMetricBadge already renders), and
     "burst" is reported per tenant — a count of workspaces whose own peak exceeded
     their own reservation, which is a comparison that is actually defined.
8. **Concept B readouts wrapped to two lines** with the "% used" chip floating beside
   the first, e.g. "4.2 GB used of 7.9 GB reserved · peak / 6.5 GB". Shortened.
9. **Concept B repeated the unit**: "1.9 vCPU used of 4.2 vCPU reserved".
10. **Concept C's micro-bars were all empty stubs.** Normalising each tenant against
    NODE CAPACITY means at 26% utilisation every tenant bar lives in the left 12% of
    its track, so the tenant-vs-tenant comparison the ledger exists for is invisible.
    → Fix: normalise each column to that column's reserved total (share among tenants),
      and move the node-capacity context to a text line in the footer.
11. **Concept C column head rendered "VCPU"** — `uppercase` applied to "vCPU".
12. **Concept D printed "0.4 vCPU vCPU"** — the unit was added to the formatter in
    iteration 1 and the literal in the JSX was not removed.
13. **Concept D's hollow pips were near-invisible** (transparent + 1px ring), and 24 of
    them read as noise. Filled to the track colour and capped at 16.
14. **Concept D's strip mixed senses**: the bar showed reserved share while the caption
    under it said "11.8 vCPU free". Added one line naming which is which.
15. **Concept D said "unknown free"** on the not-yet-provisioned node.

## Iteration 3 — findings

Concept A's iteration-1 fixes verified in the image: the exclusive ccx33 now fills
with the saturated base hues instead of the palest step, so the bar and the red 100%
readout finally agree; the 3px floor makes the cx53's 0.56% disk tenants visible.

16. **"4.2 vCPU of 16 vCPU" — unit printed twice** in concept A (the same defect I had
    just fixed in concept B; `formatVcpu` gained the unit in iteration 1 and this call
    site still had its own).
17. **The warm, empty node said "vCPU fills first".** `bindingKey` is set whenever a
    dimension has a computable percentage, including 0%, so an empty node named a
    binding dimension. Now keyed on reserved > 0.
18. Residual, accepted and documented rather than hidden: the 3px segment floor
    over-draws the cx53's disk rail by a few pixels against its own 10% readout. You
    cannot make a 0.56% tenant visible, keep 2px gaps, AND keep the aggregate exact in
    a 230px rail. This is called out in the comparison as a real limit of concept A.

## Iteration 4 — findings

Verified in the images: concept A's units are single now and the empty warm node no
longer claims a binding dimension; concept B's host tick replaced the impossible summed
peak; concept C's bars fill their tracks; concept D's empty pips are visible.

19. **Concept B flagged "4 burst" on vCPU in danger red.** All four tracked tenants
    peaked above their CPU reservation — which is NORMAL. CPU is compressible; the
    kernel time-slices it, and `workspace-resource-capacity.ts` says so in as many
    words ("CPU is COMPRESSIBLE: oversubscription makes work slower rather than
    broken"). Memory and disk are not. Painting a routine CPU burst the same red as a
    memory burst that precedes an OOM kill teaches the wrong reflex.
    → Fix: burst severity now follows the resource class. CPU bursts read muted and
      say "burst (ok)"; memory and disk bursts stay danger red.
20. **Concept D truncated its pip row to 16 and appended "+18"**, so a node that is 15%
    full by slots looked about a third full. The pips were misrepresenting exactly the
    quantity they exist to show.
    → Fix: the row now holds a full set (cap 36) and wraps, so 5 filled beside 29 empty
      reads as "nearly empty" at a glance.

## Iteration 5 — findings (desktop pass)

First inspection of the 1280 two-column boards. A, B and D all hold up; C is the
tallest by a wide margin.

21. **A and D named DIFFERENT binding dimensions for the same node.** On the saturated
    cx43, concept A said "Memory fills first" (highest reserved share, 97%) while
    concept D said "vCPU runs out first". D derives its binding key from whichever
    dimension yields the fewest slots, and all three tie at zero slots there, so the
    tie fell to iteration order. Two cards on one page contradicting each other about
    the same machine is worse than either answer alone.
    → Fix: ties on slot count break by highest reserved share, which is exactly the
      answer concept A gives.
22. **Concept B's tagline still promised "measured usage and peak"** after iteration 2
    replaced the peak tick with the host's own reading. Copy that no longer matches
    the mark it describes is the same defect as the shipped "Blue bands" legend over a
    green fill.

## Iteration 6 — verification pass

Re-opened every board at both widths plus the two real-viewport captures.
- Concept D's saturated cx43 now says "Memory runs out first", matching concept A.
- Concept A's readouts are single-unit everywhere ("7.4 of 8 vCPU").
- Concept B's CPU burst is muted "(ok)" while the RAM burst stays red.
- The 375x667 scrolled capture confirms the prototype's own container scrolls.

Automated sweep over every prototype file plus NodeCard.tsx:
- 0 unknown `--sam-*` tokens (checked against packages/ui/src/tokens/theme.css,
  apps/web/src/index.css and apps/web/src/app.css).
- 0 unregistered Tailwind colour classes (checked against the 52 names in
  apps/web/src/app.css). No `bg-bg-*`, no `bg-accent-primary`, no
  `--sam-color-border-strong`.
- No `viewBox` SVG anywhere in the prototype — every mark is a div, so the missing
  `preserveAspectRatio` trap cannot apply.
- apps/web unit suite: 313 files / 3803 tests passed.
