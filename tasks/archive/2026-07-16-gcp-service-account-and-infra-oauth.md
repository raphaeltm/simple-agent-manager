# GCP service-account credentials and admin-managed infrastructure OAuth

- SAM task: `01KXNM563MDGFSY4TTF40R0GCC`
- Parent task: `01KXNDT5PXQYWNSMTTA9G051E9`
- Parent session: `6ce412a0-4eae-4b46-b575-9298f29f269d`
- SAM idea: `01KXNG7ECVYXMY6305WEXP951P`
- Output branch: `sam/use-sam-mcp-tools-0r0gcc`

## Problem statement

GCP VM provisioning currently requires SAM's keyless Workload Identity Federation (WIF) setup flow, and that flow in turn requires every installation to configure a Google infrastructure OAuth client through deploy-time `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` values. Self-hosters who cannot or do not want to create that OAuth client need an OAuth-free connection option.

Add a second GCP authentication mode that accepts a dedicated Google service-account JSON key, validates it, stores it only in SAM's encrypted credential paths, exchanges short-lived RS256 JWT assertions at Google's fixed OAuth token endpoint, and supplies cached access tokens to the existing GCP provider. Keep WIF visibly recommended and preserve all already-stored WIF credentials.

In the same change, make the existing infrastructure/GCP OAuth client configurable and removable by superadmins at `/admin/integrations`, with encrypted runtime storage taking precedence over the existing environment fallback. This client must remain cryptographically and configurationally separate from Google login OAuth.

## Research findings

### Existing implementation seams

- `apps/api/src/services/provider-credentials.ts` already centralizes GCP credential parsing and injects a token provider into `GcpProvider` for legacy, composable, user, and platform credential resolution. Extend this seam instead of adding a second provider implementation.
- `apps/api/src/services/gcp-sts.ts` already caches short-lived WIF-derived access tokens in KV. It should dispatch on an explicit GCP credential authentication discriminator and give cache keys enough credential identity to prevent an old token surviving rotation.
- `packages/shared/src/types/user.ts` and `apps/api/src/schemas/credentials.ts` currently model only unversioned WIF metadata. Existing stored blobs have no `authType`, so parsing must normalize them as legacy WIF without requiring a migration.
- `apps/api/src/routes/gcp.ts` owns the authenticated GCP setup/verification surface, while `apps/web/src/components/GcpCredentialForm.tsx` owns the current WIF-only wizard. These are the canonical places for service-account paste/upload, verification, rotation, safe metadata, and disconnect UX.
- `apps/api/src/routes/credentials.ts` currently returns only generic connected state. GCP needs a safe response projection containing only authentication mode, project ID, service-account email, default zone, and private-key ID/fingerprint; malformed encrypted rows must not make the entire credential list fail.
- `apps/api/src/services/composable-credentials/compute-sync.ts` duplicates encrypted cloud credentials into composable credential storage and replaces only the active attachment. Service-account rotation/removal must not leave an old private-key blob active or reachable through legacy/composable resolution; the legacy row and generated composable state must change atomically.
- `apps/api/src/services/platform-config.ts` already provides DB-backed `platform_settings` plus encrypted `platform_credentials`, source metadata, bad-row isolation, environment fallback, and `/admin/integrations` status. `getGoogleInfraOAuthConfig` is the exception: it reads `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` directly. Add an independent infrastructure Google config family rather than reusing the existing `google` login family.
- `apps/web/src/components/PlatformIntegrationConfigForm.tsx` is shared by `/setup` and `/admin/integrations`. The infrastructure OAuth section belongs on the admin surface and must be clearly labelled with both static callbacks; it must not rename or repurpose the Google sign-in section.
- `platform_credentials` has `created_by` and `updated_at` but no `updated_by`. The idea requires normal rotation audit metadata, so an additive nullable `updated_by` column is required, with existing rows falling back to `created_by` when status is rendered.

### Prior incidents and guardrails

- `tasks/active/2026-07-07-first-run-admin-setup-wizard.md` records the production-relevant `redirect_uri_mismatch` found when login and infrastructure Google clients shared one resolver. Regression coverage must prove runtime or environment configuration of either family cannot enable or alter the other.
- `tasks/archive/2026-03-24-fix-gcp-oauth-static-callback.md` records that per-project Google redirect URIs made GCP setup unusable. Both infrastructure callbacks remain static: `/auth/google/callback` and `/api/deployment/gcp/callback`; entity context stays in OAuth state.
- `.claude/rules/19-external-service-integration.md` requires a self-hoster walkthrough, exact callback/scopes, multi-tenant threat model, and official external constraints.
- `.claude/rules/28-credential-resolution-fallback-tests.md` requires branch-complete credential fallback/rotation tests and an atomic per-principal rotation limiter. New service-account and infrastructure-secret mutation paths must not use KV read-modify-write as their security boundary.
- `.claude/rules/41-credential-snapshot-resilience.md` requires per-row isolation and non-throwing behavior when one stored credential is malformed or undecryptable.
- `.claude/rules/23-cross-boundary-contract-tests.md` requires realistic contract tests for the fixed Google token request, Compute verification request, browser-to-API payload, and provider token callback.

### Google constraints verified from primary documentation

- Google's server-to-server flow requires an RS256 JWT whose issuer is the service-account email, whose `scope` is space-delimited, whose audience is `https://oauth2.googleapis.com/token`, and whose lifetime is at most one hour. Exchange uses a form-encoded `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` plus the signed assertion. Access tokens are refreshed by signing and exchanging a new JWT after expiry.
- Google recommends WIF for external workloads and recommends avoiding user-managed service-account keys whenever possible. Some organizations created since May 3, 2024 have key creation/upload disabled by default, so the UI must explain that keys can be unavailable by policy.
- Service-account private keys are bearer-equivalent credentials. SAM must never log or return the uploaded JSON, private key, signed assertion, or token-exchange request body.
- SAM's GCP provider creates/manages instances and project firewall rules. Least-privilege setup therefore needs `roles/compute.instanceAdmin.v1` and `roles/compute.securityAdmin`; Vertex AI access is optional and must not be required for VM provisioning. Project Owner is not required or recommended.

References:

- https://developers.google.com/identity/protocols/oauth2/service-account
- https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys
- https://cloud.google.com/iam/docs/workload-identity-federation
- https://cloud.google.com/compute/docs/access/iam

### Multi-tenant threat model

- User A and User B receive independent encrypted credential rows and cache namespaces. No uploaded service-account key, JWT assertion, or derived token can cross a user boundary.
- A user's project-scoped composable credential override continues to take precedence over their user default, and a disabled scoped override must not silently fall through. Provider identity mismatches fail before provider construction.
- Multiple SAM projects may intentionally use the same user-level service account, but project-specific overrides remain isolated by attachment/project identity. Cache identity includes the resolved credential mode/key identity so rotation and switching modes cannot reuse a prior token.
- The infrastructure OAuth client is platform-shared by design and writable/readable only through superadmin APIs. Only configured/source/audit metadata is returned; the secret is never returned.
- A compromised service-account key has the full IAM blast radius of that service account until Google disables/deletes the key. SAM deletion removes its encrypted copies and cached derivatives but must not claim to revoke or delete Google's key.

## Implementation checklist

- [x] Add a versioned GCP credential model and legacy compatibility:
  - [x] Define explicit `workload-identity` and `service-account-key` variants in shared types and request/response schemas.
  - [x] Normalize existing unversioned WIF blobs as `workload-identity` and serialize new WIF writes with the version/discriminator.
  - [x] Reject malformed/provider-mismatched variants before a secret reaches `GcpProvider`.
- [x] Implement the service-account credential boundary:
  - [x] Parse JSON without trusting `token_uri`; require `type=service_account`, project ID, service-account email, private-key ID, and an importable PKCS#8 RSA private key.
  - [x] Sign short-lived RS256 assertions and exchange them only at SAM's fixed/allowlisted Google OAuth token endpoint with a configurable timeout and safe scope constant.
  - [x] Cache only short-lived access tokens, bound to user/project/auth mode/key identity and capped by Google's returned expiry; never persist access tokens as primary credentials.
  - [x] Verify the key and a harmless Compute API permission/readiness call before replacement, with sanitized actionable errors for malformed, revoked, disabled, underprivileged, or API-disabled credentials.
  - [x] Add an atomic D1-backed per-principal mutation limit with at-limit and rollover tests for service-account rotation.
- [x] Add atomic persistence, rotation, safe projection, and disconnect:
  - [x] Add an authenticated GCP service-account save/rotate endpoint and client contract accepting JSON text plus default zone.
  - [x] Verify before a single D1 batch replaces the legacy and generated composable credential state; a failed verification or failed batch must leave the prior credential usable.
  - [x] Ensure rotation/removal makes superseded private-key ciphertext unreachable and clears matching cached derivatives without attempting to delete the Google-managed key.
  - [x] Return only safe GCP metadata to the UI and isolate malformed/undecryptable rows so unrelated credentials still list and resolve.
- [x] Extend the GCP settings UX:
  - [x] Keep WIF first and visibly recommended; add `Service account JSON` as the warned OAuth-free alternative.
  - [x] Support both local JSON file selection and paste, default-zone selection, validation/retry feedback, rotation confirmation, and disconnect wording that accurately describes local vs Google key deletion.
  - [x] Show only safe connected metadata (auth mode, project, service-account email, zone, key ID/fingerprint) and never repopulate the JSON/private key.
  - [x] Provide copyable least-privilege `gcloud` setup commands for Compute APIs/roles, with Vertex AI explicitly optional and no Project Owner recommendation.
  - [x] Add component tests and Playwright visual audits for mobile/desktop normal, long, empty, malformed/error, rotation, unicode, and key-policy-warning states.
- [x] Add independent runtime infrastructure OAuth configuration:
  - [x] Extend platform config types/storage/status with a separate infrastructure Google client ID/secret family and encrypted secret metadata including `updated_at` / `updated_by`.
  - [x] Make `getGoogleInfraOAuthConfig` resolve runtime admin config first, then `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, while `getGoogleLoginOAuthConfig` remains unchanged and independent.
  - [x] Validate effective infrastructure ID/secret pairs before one atomic batch; reject half-configured writes and support explicit runtime removal that reveals any environment fallback.
  - [x] Add an atomic D1-backed per-superadmin mutation limit for secret rotation.
  - [x] Add a clearly labelled admin-only form section with both static callback URIs, source/audit state, rotation, and removal confirmation; never return the secret.
  - [x] Add route/service/UI regression tests proving superadmin authorization, precedence, pair atomicity, removal/fallback, secret masking, bad-row fallback, and complete login/infra separation.
- [x] Synchronize public documentation and configuration references:
  - [x] Update self-hosting guidance with the recommended WIF path, OAuth-free service-account path, exact static callbacks, least-privilege roles/APIs, key-policy warning, rotation/removal semantics, and infra OAuth runtime-vs-env behavior.
  - [x] Update security and configuration references to describe encrypted service-account JSON, non-persistence of derived access tokens, and independent Google login/infrastructure credential families.
  - [x] Update API/env references and code comments without making new deployment-time credentials mandatory.
- [x] Validate the complete change:
  - [x] Add unit/integration/vertical-slice tests for parsing, PKCS#8 import, fixed endpoint/SSRF resistance, JWT claims/signature, exchange request/response, expiry-aware caching, cache identity, verification-before-replace, atomic failure, legacy WIF compatibility, credential precedence, and sanitized errors.
  - [x] Run lint, typecheck, test, build, migration-safety, and changed-package coverage/quality checks.
  - [x] Run task-completion, Cloudflare, security, environment, UI/UX, documentation, constitution, and test-engineering reviews and address all blocking findings.
  - [x] Deploy to staging, verify D1 migration/status via the Cloudflare API, and exercise the service-account JSON path with a user-owned GCP credential. Runtime infrastructure OAuth and existing-WIF mutation journeys remained covered by independent-family route/service/browser tests and read-only staging checks because no alternate staging OAuth pair or WIF credential was supplied; the user explicitly accepted that bounded residual coverage when authorizing merge.
  - [x] Provision through the changed GCP service-account JSON path in staging and complete the requested GCP journey. On 2026-07-17 the user reported that the path was working and explicitly authorized merge after being given the connect → GCP provisioning → workspace → cleanup test sequence.

## Acceptance criteria

- [x] A SAM installation can validate and save a valid service-account JSON credential without using the infrastructure OAuth client, obtain refreshed short-lived tokens, and provision/manage a GCP node.
- [x] Uploaded `token_uri` and other endpoint fields cannot redirect SAM; private keys, assertions, request bodies, and access tokens never appear in API responses, logs, errors, UI state after save, or documentation examples.
- [x] Invalid, revoked, malformed, API-disabled, or underprivileged service-account credentials fail with sanitized actionable errors before replacing a working credential.
- [x] Rotation is atomic, invalidates the prior token namespace, and leaves no active/reachable old private-key copy; disconnect removes SAM's encrypted copies without claiming to revoke Google's key.
- [x] Existing unversioned WIF credentials continue resolving without migration breakage, and WIF remains the recommended UX path.
- [x] A superadmin can configure, rotate, and remove the infrastructure OAuth client at `/admin/integrations`; runtime values override environment values and removal visibly exposes an environment fallback when present.
- [x] Google login OAuth behavior and configuration are unchanged. Tests prove that login and infrastructure clients cannot borrow from, overwrite, enable, or disable each other.
- [x] Every new credential mutation path is superadmin/user scoped as appropriate, rate-limited with an atomic primitive, and covered by authorization/fallback/rotation tests.
- [x] Public self-hosting, configuration, and security docs accurately describe both authentication modes, exact static callbacks, least-privilege roles/APIs, key risks, and runtime/environment precedence.
- [x] Local quality gates, specialist reviews, required visual audits, staging deployment, and all feasible live GCP validation gates pass before merge.

## Task-completion audit

The initial Phase 4 task-completion review passed on 2026-07-16 with no Critical or High findings:

- Every research finding maps to an implemented checklist item, including legacy WIF normalization, fixed-endpoint service-account exchange, atomic credential replacement, safe projections, independent login/infrastructure OAuth families, and additive audit metadata.
- The browser-to-API service-account payload, route verification-before-store sequence, fixed Google token/Compute contracts, provider callback, and real SQLite atomic-store behavior are covered across contract, service, route, and integration tests. The route suite mocks service boundaries intentionally; the underlying WebCrypto/fetch/KV and D1 batch boundaries are exercised without replacing them with no-op mocks.
- The `authType` discriminator is consumed by parsing, token resolution, serialization, safe projection, and cache identity, with both WIF and service-account variants covered.
- The complete local gates passed: lint, typecheck, test, build, D1/DO migration safety, changed-package coverage, source-contract, file-size, AST, and Wrangler-binding checks. Public documentation built successfully, and the screenshot-backed web audit passed 18 mobile/desktop cases.
- Staging migration/runtime verification and feasible live GCP provisioning remain explicit later `/do` lifecycle gates and are not represented as locally complete here.

The final pre-merge task-completion review on 2026-07-17 found and fixed one High concurrency issue: two service-account rotations that began together could both read the same pre-batch attachment snapshot and leave an extra composable credential/configuration reachable. Cleanup now selects managed rows inside the atomic D1 batch, the focused store test starts replacements concurrently and proves only one coherent managed graph remains, and a second regression proves reusable user-managed GCP configurations and their attachments remain intact. The PR-scoped API suite passes 104 tests, the changed web components pass 21 tests, API lint/typecheck and API/web/docs builds pass, and migration, DO migration, source-contract, file-size, AST, and Wrangler-binding checks have no blocking errors.

The post-acceptance automated review found nine additional bounded edge cases and four coverage improvements. The implementation now scopes compatibility cleanup to `managedBy=legacy-gcp-credential`, reports D1 persistence failures as internal errors instead of upstream GCP errors, validates malformed timeout configuration, keys WIF token caches by impersonated service account while clearing legacy namespaces, limits Compute-role guidance to Compute verification, uses the canonical web API origin, handles rejected project-fetch/clipboard promises, preserves the stored zone during key rotation, and validates platform-config input with Valibot. Rotation tests now verify a coherent encrypted legacy/composable graph, runtime infrastructure secret rotation proves a single updated encrypted row, and the atomic rollback test injects a real failure during the second D1 batch write. The focused post-review gates pass 74 API tests and 18 web tests, API/web typechecks, changed-file lint with no errors, and API/web production builds.

## Phase 5 specialist review

- The security, Cloudflare, environment, UI/UX, documentation-sync, constitution, and test-engineering checklists found no remaining blocking issues. The local delegated-review runner interrupted all three read-only reviewers twice, so the same checked-in specialist instructions were applied directly and evidence was verified against `main...HEAD`.
- Review caught and fixed a cache-isolation gap: real provider construction now passes the SAM project context, derivative token keys include user/project/GCP project/auth/key identity, and rotation/disconnect enumerate and delete every matching project-scoped derivative plus legacy cache keys.
- Review added a true route-to-boundary vertical slice covering authenticated input, PKCS#8 parsing, fixed Google token and Compute requests, AES-GCM encryption, real SQLite transactional legacy/composable persistence, safe response projection, and verification-failure rollback.
- Review bounded infrastructure Google OAuth validation with the documented configurable `GCP_API_TIMEOUT_MS` helper. No private key, assertion, request body, access token, or OAuth secret is logged or returned.

## Phase 6 staging evidence and human acceptance

- Deploy Staging run `29517436830` completed successfully for commit `9ea13afde`, including application builds, API/web/tail Worker publication, D1 backup, pre/post-migration row-count integrity, health checks, security-key status, and 12 Playwright smoke tests.
- Cloudflare D1 confirms migration `0096_platform_credential_updated_by.sql` as migration ID 109, the nullable `platform_credentials.updated_by` column is present, and `PRAGMA foreign_key_check` returns no violations. Existing platform/user credential inventories remained intact.
- Seven authenticated real-browser checks passed against `app.sammy.party` on mobile and desktop: safe credential projection, malformed service-account rejection without persistence, the WIF-recommended/JSON-alternative settings journey, the independent admin Google sign-in/infrastructure OAuth sections, partial-pair rejection without mutation, a real project-detail page, no responsive overflow, and zero console/page errors. No GCP credential or runtime infrastructure setting was created.
- Staging resolves Google sign-in as `unset` and Google infrastructure OAuth as `environment`, proving the two families remain independent. The WIF start route redirects to Google Accounts with `cloud-platform` scope, static callback `https://api.sammy.party/auth/google/callback`, consent prompt, and UUID CSRF state.
- The observability-noise check found no recent GCP, Google, service-account, or platform-config errors. Its overall exit status remains non-zero because of an unrelated pre-existing Hetzner expired-trial cleanup message repeated 12 times; Workers telemetry is unavailable to the current Cloudflare token (403).
- At the initial automated validation point, D1 contained zero user GCP credentials, zero platform GCP credentials, and no runtime infrastructure OAuth values, so live service-account and GCP provisioning checks required a human-supplied staging key.
- The mandatory independent Staging Validator task `01KXNXHF3ZHS9R4GV75VSH3WVC` and two retries all failed before start because SAM could not create a chat session (references `momlpa62et2dm2u2v1uno66v`, `p0q…` from the first retry, and `bfb82ermka4smoeskgv74tei`). A fresh active-task search found no duplicate validator run.
- On 2026-07-17 the user supplied their own staging-only service-account JSON, followed the requested GCP service-account journey, reported that it was working, and explicitly said to merge. This closes the real Google exchange/provisioning blocker. The user accepted the remaining bounded live-test exception for runtime infrastructure OAuth mutation and an existing-WIF credential; those independent paths retain their route/service/browser regression evidence and read-only staging checks.
