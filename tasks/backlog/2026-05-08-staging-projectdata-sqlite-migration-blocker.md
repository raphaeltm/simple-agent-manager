# Staging deploy blocked by ProjectData new_sqlite_class migration

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
migrations. The failure prevents staging verification for unrelated code PRs.

## Acceptance Criteria

- [ ] Determine whether staging's existing `ProjectData` class was originally deployed as non-SQLite or whether generated env-specific Wrangler config is replaying an already-applied migration incorrectly.
- [ ] Identify the correct Cloudflare migration path that preserves existing staging Durable Object data.
- [ ] Update deployment config/scripts/docs so `deploy-staging.yml` can deploy without reapplying an invalid `new_sqlite_class` migration to `ProjectData`.
- [ ] Verify a staging deploy completes successfully after the fix.
