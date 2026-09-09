# The scheduler explorer teaches a slot-count model rule 69 replaced

## Problem

`apps/www/src/components/scheduler/model.ts` models node capacity as `LAB.slotsPerNode = 2` —
a fixed count of workspaces per host. `how-sam-scheduler-works.md` states it in the prose too:
"It uses two workspace slots per VM".

`.claude/rules/69-aggregate-capacity-at-final-reservation.md` exists precisely because counting
workspaces instead of summing their declared CPU and memory overpacked a 2-vCPU/4-GB node: "a
concurrency-safe workspace-slot CAS still overpacked a 2-vCPU/4-GB node because it atomically
counted workspaces instead of summing their declared CPU and memory reservations."

So the published explainer teaches the model SAM removed. It is a public docs surface, and the
first thing it teaches about capacity is the thing that caused the incident.

## Why this was not fixed in the originating PR

The placement-strategy explorer (`2026-09-09-placement-strategy-explorer-blog.md`) deliberately
built a separate aggregate-resource model rather than reworking this one. Silently rewriting a
published post's model inside an unrelated PR would have been a scope change the reviewer did not
ask for, and the two posts teach different lessons.

## Options

1. Convert `scheduler/model.ts` to aggregate CPU/memory reservations, matching
   `evaluateWorkspaceReservationCapacity`, and update the prose. Highest fidelity, most work; the
   post's scenarios are tuned around 2 slots and would all need retuning.
2. Keep the slot model but relabel it explicitly as a simplification, with a sentence pointing at
   the aggregate model and the newer post. Cheap, honest, leaves the diagram intact.
3. Retire the slot concept from the prose only, and have the lab show the co-tenant cap (which IS
   real — `PLATFORM_RESOURCE_DEFAULTS.maxCoTenants = 4`) rather than an invented 2-slot limit.

Option 3 is probably the best value: the co-tenant cap is a genuine count-based limit that exists
alongside the resource budgets, so the lab keeps a countable mechanic without teaching that counts
are how capacity works.

## Acceptance criteria

- [ ] `how-sam-scheduler-works.md` no longer presents a per-node workspace-slot count as the way
      capacity is decided
- [ ] Whatever count-based mechanic remains is one that actually exists in SAM, and is named
- [ ] `tests/scheduler-model.test.ts` updated and still passes
- [ ] The two explorers do not contradict each other on how a host decides it is full

## References

- `.claude/rules/69-aggregate-capacity-at-final-reservation.md`
- `apps/www/src/components/scheduler/model.ts`, `src/content/blog/how-sam-scheduler-works.md`
- The aggregate model built alongside: `apps/www/src/components/placement/ranking.ts`
  (`admissionRefusal` / `rankHosts` / `rankOfferings`)
