# Staging deploy blocked by missing Durable Object migration tag

## Problem

The staging deployment workflow failed while deploying the API Worker with
Wrangler error code `10074`:

> Cannot apply new-sqlite-class migration to class 'ProjectData' that is already depended on by existing Durable Objects

This was discovered during provider adapter hardening staging verification on
2026-05-08 in GitHub Actions run `25535524173`.

## Context

- Workflow: `deploy-staging.yml`
- Branch: `sam/use-skill-end-end-01kr2p`
- Failed step: `Deploy API Worker`
- Error source: `wrangler deploy --env staging`
- Related config: `apps/api/wrangler.toml` contains `[[migrations]] tag = "v1"` with `new_sqlite_classes = ["ProjectData"]`

The provider adapter branch did not modify Wrangler Durable Object bindings or
migrations. Follow-up investigation found that staging had already been advanced
to Durable Object migration tag `v14` by PR #928, while this branch did not yet
contain `v14` before it was rebased onto main.

## Acceptance Criteria

- [x] Determine whether staging's existing `ProjectData` class was originally deployed as non-SQLite or whether generated env-specific Wrangler config is replaying an already-applied migration incorrectly.
- [x] Identify the correct Cloudflare migration path that preserves existing staging Durable Object data.
- [x] Update deployment config/scripts/docs so `deploy-staging.yml` can deploy without reapplying an invalid `new_sqlite_class` migration to `ProjectData`.
- [x] Verify a staging deploy completes successfully after the fix.

## Resolution

PR #928 was merged first, bringing the `v14` Durable Object migration tag into
main. PR #931 was then rebased onto main and deployed successfully to staging in
GitHub Actions run `25543511204`, including API Worker deployment, migrations,
health check, and smoke tests.
