# Admit the first workspace despite bootstrap CPU

## Problem and authority

Idea 01M6YQ6KWZ24HA20CKPB59SYRG: a newly provisioned staging node refused its own small task three times with CPU saturation and failed it. CPU is compressible; declared reservation capacity is authoritative. An occupied node still needs a CPU saturation backstop against under-declared co-tenants.

## Research

- `workspace-resource-capacity.ts:evaluateWorkspaceReservationCapacity` calls `measuredAdmissionDiagnostic` even when activeCount is zero. Existing telemetry therefore activates the CPU saturation veto during bootstrap.
- `workspace-admission-sql.ts:finalMeasuredPressurePredicateSql` repeats this veto at final INSERT/attach/restart claims. Both must agree, with occupancy evaluated atomically.
- Direct staging D1 query for node 01M6YPW63KDV7MVEMCNHS5Z3JN returned zero rows on 2026-11-08 23:35 UTC. Historical placement explanation unavailable after deletion; no fabricated reconstruction.
- Existing controls cover occupied saturation, malformed/stale telemetry, physical memory, disk, declared budgets and concurrent claims.
- Rule 74: signal (whole-host instantaneous CPU/load) can diverge from condition (capacity for an initial workspace) during bootstrap. Rule 69: advisory and atomic final claim must enforce the same accounting.

## Checklist / acceptance

- [x] Regression drives just-ready high-CPU node through advisory evaluator and real SQLite-backed placement, using default policy.
- [x] Empty node admits fitting first request despite bootstrap CPU; occupancy at final claim still protects co-tenants.
- [x] Established saturated node rejects a new co-tenant.
- [x] Non-compressible memory/disk, declared capacity, stale/malformed telemetry remain guarded.
- [x] Prove regression red before fix; targeted tests, lint/typecheck/build, CI.
- [x] Local specialist reviews; staging slot granted by coordinator before deploy.
- [x] Staging small reservation .2 vCPU/.5GB RAM/5GB disk; delete every created staging VM.
- [x] Early DRAFT PR + needs-human-review. CodeRabbit request/wait recorded.
- [x] Exact PR/head SHA approval from coordinator before ready/merge; new commit voids approval.
- [x] Production deployment success with deployed main containing merge before bug 2 begins.

## Workflow

No main commits. Implementation used the SAM task branch/workspace. Final archive reconciliation is submitted in a separate draft PR for coordinator review; no direct main commits.

Red/green proof: four failures pre-fix (reserve, attach, first-reservation evaluator, correct disk reason during bootstrap); 111 tests passed after fix.

## Reconciliation (2026-11-09 weekly queue sweep)

- Shipped: #2595 merged 2026-11-09.
- Production deploy run on `e727f0259` (2026-11-09 01:29 UTC) succeeded and contains this merge, so the change is live.
- Process items (staging slot, coordinator approval) were not re-verified in this sweep.
- Moved from `tasks/active/` to `tasks/archive/` by the weekly reconciliation.

## Final evidence reconciliation (2026-11-09)

The process evidence omitted by the weekly sweep above has now been reviewed against [PR #2595](https://github.com/raphaeltm/simple-agent-manager/pull/2595). All checklist items are complete. The trusted CodeRabbit request was made while staging was occupied; its required wait completed. This record does not claim the request followed every other gate.

- Approved head: `71184d5c5869027bf334811b90c6cd12779b1106`; merge: `e727f025977492f658de75ea00ab8974c3bef8d7`.
- Red/green proof: four failing controls before the fix, then 111 passing targeted tests. Specialist reviews and technical CI passed.
- Coordinated staging admitted the first small reservation at 98% normalized CPU, while established-node saturation remained guarded. Explicit cleanup was independently verified in D1. Evidence: library `pr2595-bootstrap-cpu-staging-evidence.json`.
- Production [42545862134](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42545862134) succeeded before bug 2 began. Cloudflare served the merge at 100%, version `a6884b38-2858-494f-8cf8-a911226f1195`; health returned HTTP 200. Evidence: library `pr2595-production-evidence.json`.
- Final task-completion review: research, implementation, acceptance and vertical-slice coverage pass; stale workflow checkboxes reconciled here. Historical placement details unavailable after node deletion remain explicitly unavailable.
