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
- [ ] Prove regression red before fix; targeted tests, lint/typecheck/build, CI.
- [ ] Local specialist reviews; staging slot granted by coordinator before deploy.
- [ ] Staging small reservation .2 vCPU/.5GB RAM/5GB disk; delete every created staging VM.
- [ ] Early DRAFT PR + needs-human-review. CodeRabbit request/wait recorded.
- [ ] Exact PR/head SHA approval from coordinator before ready/merge; new commit voids approval.
- [x] Production deployment success with deployed main containing merge before bug 2 begins.

## Workflow
No main commits. Use existing SAM task branch/workspace. Archive notes belong in a separate draft PR, per user; keep this task active until then.

Red/green proof: four failures pre-fix (reserve, attach, first-reservation evaluator, correct disk reason during bootstrap); 111 tests passed after fix.

## Reconciliation (2026-11-09 weekly queue sweep)

- Shipped: #2595 merged 2026-11-09.
- Production deploy run on `e727f0259` (2026-11-09 01:29 UTC) succeeded and contains this merge, so the change is live.
- Process items (staging slot, coordinator approval) were not re-verified in this sweep.
- Moved from `tasks/active/` to `tasks/archive/` by the weekly reconciliation.
