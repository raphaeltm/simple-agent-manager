# Safe D1 migration deploy order

## Problem

The shared staging/production deploy workflow currently deploys the API Worker before applying D1 migrations. When a PR contains schema-dependent API code, the new Worker can serve traffic against the old D1 schema during the deployment window.

This is a non-breaking remediation task: preserve existing staging and production workflow semantics, but make the D1 migration ordering safe.

## Research findings

- `.github/workflows/deploy.yml` and `.github/workflows/deploy-staging.yml` both call `.github/workflows/deploy-reusable.yml`; the reusable workflow is the single deployment order source for production and staging.
- In `.github/workflows/deploy-reusable.yml`, the first `Deploy API Worker` step currently appears before:
  - `Backup D1 Databases (pre-migration safety net)`
  - `Record pre-migration row counts (data integrity baseline)`
  - `Run Database Migrations`
  - `Verify post-migration data integrity (BLOCKS DEPLOY ON DATA LOSS)`
- `scripts/deploy/run-migrations.ts` is a standalone helper, but the reusable workflow applies migrations inline using Pulumi stack outputs for both the primary and observability D1 databases.
- `infra/resources/database.ts` defines the primary and observability D1 databases; no Pulumi resource naming or secret changes are needed for ordering remediation.
- Existing workflow static tests live in `scripts/quality/deploy-reusable-workflow.test.ts` and `scripts/quality/deployment-workflow-hardening.test.ts`.
- Relevant retained lessons emphasize not skipping staging/deploy verification and keeping migration safeguards in CI/deploy gates (`.claude/rules/13-staging-verification.md`, `.claude/rules/31-migration-safety.md`).

## Implementation checklist

- [x] Move the existing D1 backup, pre-migration row count, migration apply, and post-migration integrity verification block before the first API Worker deploy in `.github/workflows/deploy-reusable.yml`.
- [x] Preserve first-deploy tail worker behavior: initial API deploy still occurs before tail worker, tail worker deploy still occurs before first-deploy API re-sync/redeploy with `tail_consumers`.
- [x] Preserve web deployment and worker secret configuration semantics.
- [x] Add/extend CI-friendly static workflow tests proving migrations complete before any API Worker deploy can serve new code.
- [x] Run targeted workflow quality tests.
- [x] Run relevant full quality checks.
- [x] Complete requested specialist reviews: cloudflare-specialist, env-validator, doc-sync-validator, constitution-validator, test-engineer.
- [ ] Push the output branch and open a PR that states no breaking changes and includes test evidence.
- [ ] Do not merge the PR.

## Acceptance criteria

- In both staging and production, the reusable deploy workflow applies D1 migrations before the first API Worker deployment step.
- Existing deployment semantics are preserved except for safer migration ordering.
- No secrets, resource naming, or Pulumi identity behavior changes are introduced unless strictly necessary.
- Regression coverage fails if a future change moves API Worker deployment before D1 migrations.
- PR is opened but not merged.

## References

- SAM task: `01KXT2X40ZJ6H06QR8W4238ZTS`
- Source audit task: `01KXT1G3APA0WXNRWTX8YFW50R`
- Relevant session: `d5bde5ae-b017-4d39-acbb-ba2b04a8da18`
