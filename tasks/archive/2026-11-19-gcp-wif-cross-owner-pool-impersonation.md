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
- [x] Docs: security.md, self-hosting.mdx, admin-settings.md, google-cloud.md
- [x] Production audit (counts only): one owner for every GCP credential, no conflicts
- [x] Review round 1 fixes: sticky claims (`gcp_wif_pool_claims`, first claim wins atomically, operator release), signed `user_id` = credential owner for user/project credentials, partial indexes + query-plan test, lazy settings read, fail closed on unparseable probe rows, unreadable-row retry window, leading-zero / provider-id / SA-email validation, warn-level refusal log, IAM conditions and policy version preserved
- [x] Vertical tests through the real resolver (legacy and exact paths) for project-member owner plumbing and the signed claim
- [x] Fixtures updated: capacity-pool suite applies migration 0262; teardown test uses a pool of the other user's own; orphan sweep asserts the platform owner check
- [x] Review round 2 fixes: namespaced fallback `project_id` (`gcpIdentityTokenProjectId`, `gcp-project:<id>`); per-check D1 query cap (`gcpWif.poolIndexMaxQueriesPerCheck`, exact statement count); fail closed (503) on malformed batch results and D1 faults while indexing
- [x] Composable (`cc_credentials:`) exact-path owner test (G23); reverted an accidental `tokenUserId` log-key rename in four unrelated MCP files
- [x] Deferred (MEDIUM, with justification): open issuer-only providers on pools SAM never recorded, and claims without proof of Google control → `tasks/backlog/2026-11-19-gcp-wif-probe-open-providers-before-claim.md`
- [ ] Full quality suite
- [ ] Reviews: security-auditor (re-verify), task-completion-validator, cloudflare-specialist
- [ ] Staging: live save-time and exchange-time refusals

## Review round 1 (2026-11-19)

- security-auditor H1: ownership disappeared with the credential row while Google's `pool/*` binding survived; a disconnect re-opened the hole. Fixed with sticky claims.
- security-auditor M2: save race. Fixed: the claim insert is atomic on the pool key and re-read.
- validator HIGH / security M4: project-attached credentials signed `user_id = project:<pid>:<uid>`, which the user-scoped provider rejects. Fixed: `gcpIdentityTokenUserId()` signs the credential owner's id.
- cloudflare 1/3/6: full scans, settings read on the hot path, fail-open on unparseable rows. Fixed.
- security M3 (409 reveals another owner uses a project number), L1 (parser divergence; not exploitable because the exchange check keys on the credential actually exchanged), L3 (cached tokens): documented as residual.

## Review round 2 (2026-11-19)

- Independent security re-verification: no CRITICAL/HIGH; no impersonation path for any owner SAM has recorded. M2 (signed `project_id` fell back to the credential's typed `gcpProjectId`, spoofable against a deployment provider) fixed with `gcpIdentityTokenProjectId()`. M1 (a pool SAM has never recorded whose Google trust is still issuer-only can be claimed first by anyone: impersonation) **deferred** to `tasks/backlog/2026-11-19-gcp-wif-probe-open-providers-before-claim.md`: the fix is a Google probe before first claim, and probing already-claimed pools would refuse production's one legacy connection until re-run, which needs Raphaël's decision. Round-2 confirmation: PASS.
- Cloudflare re-check: no HIGH. Batch-envelope fail-open and per-check query budget fixed; claims without proof of control deferred to the same backlog task.

## Acceptance criteria

- [x] User B cannot save, or exchange with, a credential naming user A's pool (409 / refusal before signing): `gcp-wif-pool-ownership.test.ts` "attack: user B naming user A's pool…", "POST /api/credentials: B naming A's pool gets 409…"
- [x] A user credential cannot name the platform credential's pool, and vice versa: "attack: a user credential cannot name the platform credential's pool", "attack: the platform credential cannot name a user's pool", "POST /api/credentials: a user cannot save the platform credential's pool"
- [x] The owner, the same user's project-scoped credential, and a project member using it still work: "owner control…", "a project member using another member's project credential…", exact and composable exact-path resolver tests
- [x] New guided user-level setups use `assertion.user_id == '<userId>'` and `attribute.sam_user/<userId>`; re-runs fix existing providers and bindings: `gcp-wif-scoping.test.ts` (Google faked; strings, PATCH path and `pool/*` removal)
- [x] Production has no cross-owner sharing (verified: counts above)
- [ ] Refusals shown live on staging

## References

- `.claude/rules/19-external-service-integration.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/41-credential-snapshot-resilience.md`, `.claude/rules/62-tests-must-observe-the-real-trigger.md`
