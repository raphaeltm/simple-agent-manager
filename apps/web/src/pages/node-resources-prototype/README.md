# Prototype — node resource-utilisation concepts

Route: `/prototype/node-resources` (dev-only, unauthed, no API calls).

Four genuinely different answers to "put a resource visualisation on the node card",
rendered inside the **real** `NodeCard` from `/nodes` via its prototype `resourceSlot`
prop, so the preview includes the real badges, hardware block, workspace list and the
actual vertical cost of each option.

| Concept | Question it answers | Optimises for | Breaks down when |
|---|---|---|---|
| **A · Capacity rails** | How full is this node, and who is in it? | One glance, three dimensions, per-workspace attribution, smallest vertical cost of the four | Utilisation is low — sub-1% tenants need a 3px floor to be visible at all, which over-draws the rail slightly against its own percentage |
| **B · Reserved vs used** | Did we ask for the right size? | Showing waste and OOM risk; the only concept that uses the PR #2110 telemetry | A node whose workspaces have no telemetry yet has nothing to draw |
| **C · Workspace ledger** | Which workspace is costing me this node? | Per-tenant comparison; it is also a better workspace list than the one it sits above | Tenant count — five workspaces is already the tallest card of the four |
| **D · Headroom slots** | What fits here next? | The scheduling decision; the only concept that answers it directly | The yardstick is the median tenant already on the node, so a node with one outlier tenant gives a misleading slot size |

## Files

- `index.tsx` — page shell, concept switcher, its own viewport-height scroll container
- `mock-data.ts` — fixtures in the real wire shapes
- `capacity.ts` — capacity derivation mirroring the scheduler
- `viz-tokens.ts` — the validated palette and formatters
- `RailTrack.tsx` — the shared segmented track
- `Concept*.tsx` — one file per concept

## Removal before merge to main

1. Delete this directory.
2. Remove the `resourceSlot` prop from `apps/web/src/components/node/NodeCard.tsx`.
3. Remove the lazy import and `/prototype/node-resources` route from `apps/web/src/App.tsx`.
4. Delete `apps/web/tests/playwright/node-resources-prototype-audit.spec.ts`.
