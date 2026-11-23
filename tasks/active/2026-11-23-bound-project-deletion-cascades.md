# Bound project deletion cascade work

## Problem

Project deletion can monopolize shared D1 while foreign-key actions repeatedly scan unrelated history. Keep authorization, the atomic delete batch, and cascade semantics intact.

## Research

- `apps/api/src/routes/projects/crud.ts` explicitly removes task events, then tasks, then the project in one atomic batch.
- Retained checkpoint archives from migrations 0202/0204 retain event foreign keys after losing their secondary indexes.
- Resource-history task foreign keys have project-leading indexes, which cannot seek a task-only foreign-key check. Other task children also lack supporting indexes.
- Existing route SQL fixtures omit foreign keys and indexes; they cannot observe cascade amplification.
- Production diagnostics and attribution are recorded privately in SAM; public evidence uses synthetic fixtures only.

## Preflight

Classification: business-logic-change, cross-component-change, docs-sync-change. Request → project capability check → Drizzle D1 batch → FK cascades → R2 cleanup. Prefer additive indexes over deletion redesign, retries, or schema recreation. No public contract changes. Constitution II, X, XI, XII, XIII checked: preserve atomicity, authorization and data; no tunable added.

## Implementation checklist

- [ ] Confirm origin using narrow read-only evidence and real schema query plans.
- [ ] Reproduce real DELETE operation at realistic cardinality with shipped schema/FKs/indexes.
- [ ] Prove a query-plan/work regression fails before correction.
- [ ] Add the smallest additive migration and matching canonical schema indexes.
- [ ] Verify ownership rejection, event/task cascade, SET NULL and unrelated project preservation.
- [ ] Test migration on populated upgrade and clean migration chain.
- [ ] Run relevant quality checks and local specialist reviews.
- [ ] Deploy staging; bounded synthetic deletion alongside unrelated workspace operations; clean up fixtures.
- [ ] Complete CI and CodeRabbit gates, merge, production deploy and basic health/version smoke.

## Acceptance

Real statement attribution backed by private evidence; no repeated full-history scans in the implicated cascade; regression red before fix and green afterward; deletion correctness and unrelated operations preserved; staging validation and basic production smoke pass.

## References

Rules 02, 31, 35, 62, 69 and 81; Cloudflare D1 query insights and EXPLAIN QUERY PLAN documentation.
