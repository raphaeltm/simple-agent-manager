# Bound parent lookups in project deletion

## Problem and research
Project deletion still scans unrelated FK children after the earlier task/event index correction. The real route deletes profiles and the project as well as tasks/events. Its regression currently examines only task/event DELETE plans, omitting other issued statements. Read-only production analytics and attribution stay in private SAM records; public verification uses synthetic data only.

## Preflight
Business-logic-change and docs-sync-change. Trace: authenticated project delete → ownership/capability check → atomic D1 mutation batch → FK actions → asynchronous R2 cleanup. Prefer additive indexes on evidenced scans. Preserve all ownership, cascade, SET NULL, scheduler and secret-expiry semantics. No retries or new infrastructure.

## Checklist
- [ ] Attribute the costly operation with private evidence and document any remaining attribution gap in SAM.
- [ ] Reproduce through the actual route, shipped migration chain, foreign keys, indexes and realistic unrelated history.
- [ ] Expand the existing regression to every relevant issued DELETE and prove it fails before correction.
- [ ] Add the smallest supported additive indexes, matching canonical schema where applicable.
- [ ] Verify clean install and populated upgrade preserve data and FK actions.
- [ ] Verify unrelated access, ownership, secret expiry and scheduler completion/fairness.
- [ ] Run quality checks and independent local specialist reviews.
- [ ] Deploy to staging and perform bounded reproduction with concurrent session verification; clean fixtures.
- [ ] Complete CI and CodeRabbit review, merge, production deploy and read-only health/version smoke.

## Acceptance
The causal operation or remaining observability blocker is stated honestly in private SAM. Regression fails before and passes after, bounded correction retains correctness and normal scheduling, staging sessions remain available, and production basic smoke passes. Public artifacts contain no raw incident evidence.

## References
Rules 02, 31, 35, 62 and 69. Existing project-delete-cascade-cost route test. Cloudflare D1 query-insights and query-plan documentation.
