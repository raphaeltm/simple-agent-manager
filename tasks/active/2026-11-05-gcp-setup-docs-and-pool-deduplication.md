# GCP setup documentation and duplicate pool repair

## Request
Publish today's GCP learnings in public docs ASAP, then deploy a fix for one connection appearing twice in the node pool.

## Findings
- Resource Manager and IAM calls failed SERVICE_DISABLED in the OAuth consumer project; generic 403 advice obscured cause.
- OAuth-client and VM projects have separate API prerequisites. Default zone does not cause disabled IAM errors.
- GCP compatibility store writes identical legacy and CC credentials with random IDs; catalog dedupe only recognizes older deterministic mirror IDs. Production produced two active sources, each with 18 candidate rows.

## Checklist
- [x] Publish GCP setup/troubleshooting guide and navigation links in independent docs release.
- [x] Validate www lint, typecheck, build and links; independent docs/task review; CI and CodeRabbit gate; confirm public deployment.
- [x] Implement canonical mirror identity/deduplication for GCP connections and safely reconcile existing pool duplicates without losing selections or breaking references.
- [x] Add meaningful regressions for connection-to-catalog/pool flow and distinct accounts.
- [x] Run API validation and independent Cloudflare/security/test/constitution/task reviews.
- [x] Verify deployed staging behavior before fix PR.
- [ ] Merge and monitor production rollout with bounded smoke.
- [x] Update known-issue docs when fix ships.

## Acceptance
Public guidance precedes fix deployment. One logical GCP connection yields one pool source; genuine distinct accounts remain distinct. Existing duplicate pool repaired safely. No secrets in logs/docs or ad hoc destructive production cleanup.

## References
Ideas 01M6NGW3JR03WBJGF932RR821H (error messages; deferred separately) and 01M6NK4EWSZ9X2QKY05G0EZC6E (duplicate source).
Code: gcp-credential-store.ts, provider-catalogs-seeds.ts, default-capacity-pool-sources.ts, gcp-errors.ts.

## Implementation validation
20 focused regressions pass, including revision/source/credential races, batch rollback, unmatched selections, distinct connections, live references, and idempotent digest/revision. Independent security/Cloudflare and test/constitution reviews pass. Full API checks and staging pending.

## Release evidence
- Public guide #2538 merged as 56e55f233; Marketing Site run 42015097219 succeeded. Live canonical www guide verified before staging deployment.
- API lint/typecheck/build pass. Full suite: 15,082 passed, 2 skipped, one unrelated archive test exceeded its default five-second timeout under concurrent validation load. Isolated rerun with original timeout passes in 2.45 seconds. No test configuration changed.
- Follow-up public guide builds 273 pages; 0 broken links across 46 docs.
- Staging run 42015513919 passed for runtime commit 17128644aecfd5a024e680b36a5e9ab19c237201. Worker version aad4a3d5-ae28-4433-be9e-a11ec798ff2b at 100%.
- Temporary WIF metadata on an initially credential-free smoke account reproduced two API sources and duplicate browser headings before deployment. After upgrade, one active source remains, duplicate is disabled, and both sets of 48 historical candidate rows remain. Pool is configured-ready with 24 available role-visible offerings.
- Browser renders Allowed machines (3), each machine once, with no page errors. Refresh/reload and stable revision verified. Dashboard, projects and agent settings navigation passed. Cleanup recorded in PR. No VM or Google authentication was attempted.

## Post-mortem
Random-ID managed dual writes introduced by b00b2952d (#1612) were missed by a catalog reader that only recognized older deterministic mirror prefixes. Writer-only storage tests did not assert logical source count downstream. Scoped rule 44 now requires reader inventory and real writer-to-consumer count tests with distinct-account controls. Runtime repair preserves selections and references under atomic revision/source/identity fences.

## CodeRabbit follow-up
PR #2540 CI passed at head 0ebe85960. CodeRabbit was requested once after green CI and returned five findings after an active review. Shared seed/mirror snapshot and non-null legacy identity fixes have regression coverage. The repair now compares an ordered candidate snapshot before acquiring a unique source-generation lease; authority updates use bounded chunks in one atomic batch. Matched retained candidates refresh catalog state independently of source-wide retirement, while unmatched overrides remain unchanged. Canonical-only selections now have explicit union coverage. Revised checks and follow-up staging verification are required before merge; the earlier staging result applies to the original runtime only.

Follow-up local validation: 28 focused GCP regressions and all 138 default-capacity-pools tests pass, including 2,000 historical rows with a two-row update chunk budget, candidate insertion/update races, source publication ownership, retained catalog freshness/idempotence, and preserved canonical-only selections. Independent correctness review passes.
