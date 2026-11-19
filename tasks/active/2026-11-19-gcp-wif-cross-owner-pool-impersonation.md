# Block cross-owner GCP workload identity pool impersonation

SAM task: 01M7SB8FRZ08M5NEX9WGM74X61 (dispatched by coordinator task 01M7JMXS2JRW6QQMB1356ENPM3). Severity HIGH, in production.

## Problem

User-level guided GCP setup created a pool provider whose attribute condition checked only SAM's issuer (`assertion.iss == '<issuer>'`) and granted the service account to `principalSet://.../workloadIdentityPools/<pool>/*`. `exchangeGcpWifAccessToken` signed an identity token for whatever pool a stored credential named, and `POST /api/credentials` only checked field formats. User B could save a credential naming user A's (or the installation's) pool, SAM signed a token, A's provider accepted the issuer, and `pool/*` let B impersonate A's service account.

## Research findings

- Pool identities are inside encrypted payloads in `credentials`, `platform_credentials` and `cc_credentials`; only `project_deployment_credentials` stores them in plaintext. An indexed lookup therefore needs a Worker-maintained index.
- Credential writers are numerous (routes, mirrors, make-default, lazy backfill). An index maintained by writers would desync (rule 44), so the index is self-reconciling: each check indexes rows whose IV the index has not seen, in the same D1 batch as the owner read.
- `getGcpAccessToken` callers: `routes/gcp.ts` (user), `provider-credentials.ts` (composable, legacy project/user/platform), `gcp-token-provider.ts` (exact path, catalogs, price table, API health, orphan reconciliation). Project-scoped credentials can be used by a member other than the one who saved them, so the exchange owner is the stored row's owner, plumbed through `ProviderFactory`.
- The token's `user_id` claim is the cache identity (`<uid>`, `project:<pid>:<uid>`, `platform:<uid>`); unchanged.
- `runGcpSetup` had no caller passing `samProjectId` (dead branch); `runGcpDeploySetup` always passes one.
- Re-running setup must also remove the legacy `pool/*` member, or an older issuer-only provider in the same pool keeps the hole open.
- Production audit (counts only, no decryption, 2026-11-19): 1 user-level GCP cloud row, 1 composable GCP row, 1 deployment row, 0 platform GCP rows, all belonging to ONE owner. No cross-owner sharing exists, so fix 1 cannot break production.

## Implementation checklist

- [x] `gcp-wif-pool-ownership.ts`: pool identity normalization, self-reconciling index, owner check, fail-closed budget, per-row isolation
- [x] Migration `0262_gcp_wif_pool_index.sql` + drizzle schema + deployment pool index
- [x] Admin settings `gcpWif.poolIndexPageSize` / `gcpWif.poolIndexBudgetMs`
- [x] Exchange-time refusal before signing (`gcp-sts.ts`), explicit `GcpTokenRequester` at every call site, row owner for project-scoped credentials
- [x] Save-time refusal: user GCP store (POST /api/credentials, /api/gcp/setup), project credentials, composable credentials, admin platform credentials
- [x] Guided setup checks the pool after reading the project number, before any Google mutation
- [x] User-scoped provider condition and `attribute.sam_user/<userId>` binding; update path rewrites the condition; re-run removes `pool/*`
- [x] Real-SQL attack/owner-control tests; each guard deleted once (results in PR)
- [x] Unit tests for condition/binding strings and the update path
- [ ] Docs: security.md, self-hosting.mdx, admin-settings.md, google-cloud.md
- [ ] Full quality suite
- [ ] Reviews: security-auditor, task-completion-validator, cloudflare-specialist
- [ ] Staging: live save-time and exchange-time refusals

## Acceptance criteria

- [ ] User B cannot save, or exchange with, a credential naming user A's pool (409 / refusal before signing)
- [ ] A user credential cannot name the platform credential's pool, and vice versa
- [ ] The owner, the same user's project-scoped credential, and a project member using it still work
- [ ] New guided user-level setups use `assertion.user_id == '<userId>'` and `attribute.sam_user/<userId>`; re-runs fix existing providers and bindings
- [ ] Production has no cross-owner sharing (verified: counts above)
- [ ] Refusals shown live on staging

## References

- `.claude/rules/19-external-service-integration.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/41-credential-snapshot-resilience.md`, `.claude/rules/62-tests-must-observe-the-real-trigger.md`
