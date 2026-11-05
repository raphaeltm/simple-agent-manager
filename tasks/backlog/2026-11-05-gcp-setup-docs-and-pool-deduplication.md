# GCP setup documentation and duplicate pool repair

## Request
Publish today's GCP learnings in public docs ASAP, then deploy a fix for one connection appearing twice in the node pool.

## Findings
- Resource Manager and IAM calls failed SERVICE_DISABLED in the OAuth consumer project; generic 403 advice obscured cause.
- OAuth-client and VM projects have separate API prerequisites. Default zone does not cause disabled IAM errors.
- GCP compatibility store writes identical legacy and CC credentials with random IDs; catalog dedupe only recognizes older deterministic mirror IDs. Production produced two active sources, each with 18 candidate rows.

## Checklist
- [ ] Publish GCP setup/troubleshooting guide and navigation links in independent docs release.
- [ ] Validate www lint, typecheck, build and links; independent docs/task review; CI and CodeRabbit gate; confirm public deployment.
- [ ] Implement canonical mirror identity/deduplication for GCP connections and safely reconcile existing pool duplicates without losing selections or breaking references.
- [ ] Add meaningful regressions for connection-to-catalog/pool flow and distinct accounts.
- [ ] Run API validation and independent Cloudflare/security/test/constitution/task reviews.
- [ ] Verify deployed staging behavior before fix PR; merge and monitor production rollout with bounded smoke.
- [ ] Update known-issue docs when fix ships.

## Acceptance
Public guidance precedes fix deployment. One logical GCP connection yields one pool source; genuine distinct accounts remain distinct. Existing duplicate pool repaired safely. No secrets in logs/docs or ad hoc destructive production cleanup.

## References
Ideas 01M6NGW3JR03WBJGF932RR821H (error messages; deferred separately) and 01M6NK4EWSZ9X2QKY05G0EZC6E (duplicate source).
Code: gcp-credential-store.ts, provider-catalogs-seeds.ts, default-capacity-pool-sources.ts, gcp-errors.ts.
