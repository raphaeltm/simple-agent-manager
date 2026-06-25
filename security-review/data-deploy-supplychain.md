# Security Review: Domain F - Data Layer, Migrations, Deployment & Supply Chain

Date: 2026-06-25
Branch: `security-review/data-deploy-supplychain`
Scope: D1/Drizzle data access, raw SQL, ProjectData and related Durable Object SQLite usage, migration safety, deployment/secrets scripts, wrangler binding generation, app-deployment image transport/signing/Compose handling, and GitHub Actions supply chain controls.

## Multi-Level Review Status

Three required SAM subtasks were dispatched with profile `01KSWW2DQTZ8N3F2PYXKMJ7QZZ` and mission `c879abb0-770a-4187-8503-77dc1ba42ca8`:

- `01KVZ8QXVBZD2DVBD3BBTV6DWR` - SQL/data-isolation + migration safety: failed before producing an output summary.
- `01KVZ8RB2H4BSK94X4R65CZE0N` - deployment scripts + secret handling/wrangler/app-deployment: failed before producing an output summary.
- `01KVZ8RQEBEB0S0A1YC3YJNY9V` - CI/CD workflows + supply chain: failed before producing an output summary.

Because all three child reviews failed without usable findings, this report is synthesized from the main local audit only. No code was modified beyond this report file.

## Domain Summary

The D1 and Durable Object SQL surfaces are generally parameterized. Dynamic `IN (...)` lists reviewed build placeholder strings from array lengths and bind all values; Drizzle `sql` fragments reviewed did not directly interpolate user strings as SQL identifiers. D1 and DO migration safety checks exist in CI and block new destructive DDL/DML patterns. Wrangler config hygiene is mostly strong: checked-in `wrangler.toml` files do not contain `[env.*]` sections, and environment sections are generated from Pulumi outputs at deploy time. Deployment apply payloads are signed, bound to environment/node/sequence, and R2 image artifacts are scoped and hash-verified.

The main risks are in app-deployment and migration guardrails: compose-publish `provider:` services bypass the service deny-list, and deployment row-count checks violate the sentinel-row exclusion rule for `users`, creating a blind spot for small-install data loss. Lower-severity issues include possible secret leakage in secret-configuration error paths and an unpinned ad hoc staging dependency install.

## Severity Counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 2 |
| Medium | 2 |
| Low | 0 |

## Findings By Severity

### High

#### DATA-001: Compose-publish `provider:` services bypass denied security fields

Severity: High
CWE: CWE-284 Improper Access Control
Location: `apps/api/src/services/compose-publish-apply.ts:405`

Description: `buildComposePublishApplyPayload()` passes any service containing a `provider` key through verbatim at lines 405-410, before the deny-list stripping that removes dangerous fields from normal services at lines 457-467. The normal deny-list includes `privileged`, `cap_add`, `network_mode`, `devices`, `security_opt`, `pid`, `ipc`, `env_file`, `secrets`, and managed `labels` in `packages/shared/src/compose-parser/constants.ts:55`.

Impact/Exploit: A malicious or compromised agent that can submit compose-publish releases may add `provider:` to a service and attempt to smuggle normally denied Compose fields into the signed deployment payload. If Docker Compose accepts any of those fields alongside `provider`, the deployment node could run with host networking, elevated Linux capabilities, device access, custom labels, or other fields SAM explicitly rejects for tenant isolation. Needs-verification: Docker Compose provider-service semantics should be tested to confirm which normal service fields are honored with `provider:`.

Evidence:
- `apps/api/src/services/compose-publish-apply.ts:405-410` passes provider services through unchanged.
- `apps/api/src/services/compose-publish-apply.ts:457-467` strips denied fields only after the provider early-continue.
- `packages/shared/src/compose-parser/constants.ts:55-96` lists denied service fields intended to enforce the security boundary.

Remediation: Do not pass provider services through without validation. For provider services, reject the intersection of `DENIED_SERVICE_FIELDS` and any other unsupported service keys before preserving provider-specific fields. Add tests with `provider:` plus `privileged`, `network_mode: host`, `devices`, `cap_add`, `labels`, and `env_file` to prove they are rejected or safely stripped.

Confidence: Medium. The bypass in SAM code is concrete; exploitability depends on Docker Compose accepting denied fields on provider services.

#### DATA-002: Migration row-count integrity check includes sentinel users and can miss small-install user loss

Severity: High
CWE: CWE-693 Protection Mechanism Failure
Location: `.github/workflows/deploy-reusable.yml:564`

Description: The production deployment workflow records and verifies row counts with `SELECT COUNT(*) as count FROM $table` for every table, including `users`, at lines 564-568 and 621-624. This violates rule 40 for sentinel-bearing tables: `users` contains the `system_anonymous_trials` sentinel seeded in `apps/api/src/db/migrations/0043_trial_foundation.sql:20`, and business/protection counts must exclude `status='system'`.

Impact/Exploit: On a fresh or small self-hosted install, a bad migration could delete all real human users while leaving the sentinel row. The guard would see `users` drop from 2 to 1, not to 0, and because the `>50%` check only applies when `PRE_COUNT > 10`, deployment would continue after losing all real users. This is a data-loss detection bypass for the exact class of incident the migration safety rules are meant to prevent.

Evidence:
- `.github/workflows/deploy-reusable.yml:564-568` records pre-migration counts for `users` with no sentinel predicate.
- `.github/workflows/deploy-reusable.yml:621-624` records post-migration counts with the same unfiltered query.
- `.github/workflows/deploy-reusable.yml:631-639` only fails on zero rows or `PRE_COUNT > 10` plus >50% loss.
- `.claude/rules/40-sentinel-rows-excluded-from-counts.md` requires sentinel rows be excluded at the source.

Remediation: Special-case sentinel-bearing tables in the count loop. For `users`, count `WHERE status != 'system'` for both pre- and post-migration checks, and fail if real-user count decreases unexpectedly. Consider a table-to-query map so future sentinel-bearing tables cannot be accidentally counted with bare `COUNT(*)`.

Confidence: High.

### Medium

#### DATA-003: Secret configuration script may echo secret-bearing `wrangler` stderr on failure

Severity: Medium
CWE: CWE-532 Insertion of Sensitive Information into Log File
Location: `scripts/deploy/configure-secrets.sh:51`

Description: `set_worker_secret()` pipes each secret value to `wrangler secret put` and captures full command output at line 51. On unexpected failure it prints `Error: $output` at line 61. If `wrangler`, a wrapper, shell tracing, or a future error path includes stdin/config context in stderr, deployment logs can receive plaintext Worker secrets such as `JWT_PRIVATE_KEY`, `DEPLOY_SIGNING_PRIVATE_KEY`, `ORIGIN_CA_KEY`, OAuth client secrets, or R2 credentials.

Impact/Exploit: Anyone with access to GitHub Actions logs for a failed deployment could recover platform signing/encryption material if the toolchain ever echoes secret input. GitHub masks exact secret values sourced from GitHub Secrets, but Pulumi-derived generated secrets read with `--show-secrets` may not be registered as GitHub masks, and derived/transformed values may evade masking.

Evidence:
- `scripts/deploy/configure-secrets.sh:21` reads Pulumi outputs with `--show-secrets`.
- `scripts/deploy/configure-secrets.sh:51` sends secret material to `wrangler secret put`.
- `scripts/deploy/configure-secrets.sh:60-61` prints the captured output on failure.

Remediation: Treat `wrangler secret put` output as sensitive. Do not print raw stderr for secret-setting failures; print the secret name and exit code only, or redact all configured secret values before logging. For Pulumi-derived values, add explicit `::add-mask::` calls before any command that might log them.

Confidence: Medium. The current script does not intentionally echo secret values, but the failure logging pattern is unsafe for secret-handling commands.

#### DATA-004: Staging smoke tests install latest Playwright outside the lockfile in a secret-bearing job

Severity: Medium
CWE: CWE-829 Inclusion of Functionality from Untrusted Control Sphere
Location: `.github/workflows/deploy-staging.yml:49`

Description: The staging smoke-test job runs with `SMOKE_TEST_TOKEN` in the job environment at lines 38-40, then creates a temporary npm project and runs `npm install @playwright/test` without a version pin or lockfile at lines 49-54. This bypasses the repository `pnpm-lock.yaml` integrity model used by CI and executes whatever version npm resolves at runtime in a job that has staging smoke credentials.

Impact/Exploit: A compromised npm release, dependency confusion event, or malicious transitive package install script could execute during the staging smoke-test job and read environment variables including `SMOKE_TEST_TOKEN`, staging URLs, and the default GitHub Actions token context. This does not expose production deploy secrets, but it weakens CI/CD supply-chain controls on a privileged staging validation path.

Evidence:
- `.github/workflows/deploy-staging.yml:38-40` places `SMOKE_TEST_TOKEN` in job env.
- `.github/workflows/deploy-staging.yml:49-54` runs unpinned `npm install @playwright/test` and `npx playwright install chromium`.
- Main CI uses `pnpm install --frozen-lockfile`, e.g. `.github/workflows/ci.yml:78-82`.

Remediation: Use the repository-managed Playwright dependency and `pnpm install --frozen-lockfile`, or pin `@playwright/test` to an exact version with `npm ci` from a committed lockfile in a dedicated smoke-test package. Minimize the env scope of `SMOKE_TEST_TOKEN` to only the test execution step, not the dependency installation step.

Confidence: High.

## Reviewed Areas With No Finding

- Raw SQL reviewed in D1 route/service paths generally uses positional bind parameters. Dynamic placeholder lists are derived from array lengths rather than user strings.
- ProjectData Durable Object SQLite access is per-project by deterministic DO name and uses parameterized `sql.exec(..., args)` patterns in reviewed modules.
- D1 migration safety and DO migration safety checks are present in CI (`.github/workflows/ci.yml:317-321`) and scan destructive patterns.
- Checked-in `wrangler.toml` files do not contain committed `[env.*]` sections; env-specific sections are generated by `scripts/deploy/sync-wrangler-config.ts`.
- Deploy signing verifies expiry, environment ID, node ID, monotonic sequence, Compose hash, route hash, interpolation-env hash, and artifact hash before apply (`packages/vm-agent/internal/deploy/signature.go:50-97`).
- R2 compose image artifacts are project/environment/workspace scoped, have size and SHA-256 validation, and are hash-verified before `docker load` (`apps/api/src/services/compose-image-artifacts.ts:126-189`, `packages/vm-agent/internal/deploy/artifacts.go:79-111`).
- GitHub Actions workflows reviewed do not use `pull_request_target`; third-party actions are SHA-pinned. Local reusable workflow references are expected and not a third-party pinning issue.
