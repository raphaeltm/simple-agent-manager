# Enforce Aggregate Capacity at the Final Atomic Reservation

## When this applies

Any scheduler or allocator that reuses a finite resource across concurrent tasks, including VM
nodes, runner pools, deployment hosts, leases, and quota buckets.

## Why this exists

A concurrency-safe workspace-slot CAS still overpacked a 2-vCPU/4-GB node because it atomically
counted workspaces instead of summing their declared CPU and memory reservations. Advisory
selection knew whether one request fit the whole node, but neither selection nor the final write
subtracted active reservations. Three whole-node requests therefore passed a three-slot cap.

## Hard requirements

1. Define capacity in the resource's authoritative units and keep one shared accounting policy
   for advisory selection and final reservation.
2. Repeat every capacity and isolation invariant in the final atomic write. A preselection check
   is an efficiency hint, never the correctness boundary.
3. Persist the exact reservation snapshot consumed by the final write. Do not re-resolve inputs
   between task admission and resource reservation.
4. Treat missing or malformed active reservation/capacity data as unknown. Unknown data may have
   an explicit one-occupant compatibility path, but must never enable co-tenancy.
5. Count every lifecycle state that still owns resources and test the states that release them.
6. Keep count limits only as additional safety caps when actual capacity has multiple dimensions.

## Required tests

- A fixture where one request consumes the smallest node's full declared CPU or memory.
- A larger-node matrix that admits fitting sums and rejects the first overflowing dimension.
- A real database race where two contenders request the final capacity and exactly one wins.
- Both directions of exclusivity: exclusive request onto occupied node and ordinary request onto
  an exclusively occupied node.
- Missing/malformed legacy data, plus the explicit empty-node compatibility control.
- All resource-owning and resource-releasing lifecycle states.
- Existing tenant, project, pool, and credential-scope isolation controls.

## References

- `apps/api/src/services/workspace-placement.ts`
- `apps/api/src/services/workspace-resource-capacity.ts`
- `tasks/active/2026-09-04-aggregate-workspace-resource-reservations.md`
