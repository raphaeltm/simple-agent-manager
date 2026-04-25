# Upgrade Wrangler to v4+ to Unblock Artifacts-Backed Projects

**Priority**: HIGH — feature is broken in production
**Created**: 2026-04-25

## Problem

The Artifacts-backed projects feature is **broken in production**. The `[[artifacts]]` binding in `wrangler.toml` requires Wrangler v4+, but the deploy pipeline uses Wrangler v3.114.17, which silently ignores the binding (logs "Unexpected fields found in top-level field: artifacts"). At runtime, `env.ARTIFACTS` is `undefined`, causing "Artifacts binding is not configured" errors.

## What Needs to Happen

- [ ] **Upgrade Wrangler to v4+** in `package.json` devDependency + CI workflows
- [ ] **Check Wrangler v4 changelog/migration guide** for breaking changes affecting D1, KV, R2, DO, AI, tail_consumers, or the `sync-wrangler-config.ts` script
- [ ] **Update `sync-wrangler-config.ts`** if Wrangler v4 changes how env sections or bindings are structured
- [ ] **Restore the binding check** in the config endpoint (`apps/api/src/index.ts`):
  - Currently: `return c.json({ enabled: c.env.ARTIFACTS_ENABLED === 'true' });`
  - Should be: `return c.json({ enabled: c.env.ARTIFACTS_ENABLED === 'true' && !!c.env.ARTIFACTS });`
- [ ] **Deploy to staging** and create an Artifacts-backed project end-to-end:
  - Fill the project creation form, select Artifacts provider
  - Click Create, verify the project is created
  - Use project chat to have an agent create and push files to the repo
  - Verify ZERO errors during the entire flow
- [ ] **Verify existing features still work** — Wrangler upgrade must not break any existing bindings

## Context

- Post-mortem: `docs/notes/2026-04-25-artifacts-broken-merge-postmortem.md`
- Rule: `.claude/rules/30-never-ship-broken-features.md`
- The feature code is complete (DB migration, API routes, UI, git token endpoint, cloud-init changes) — it just needs a working `env.ARTIFACTS` binding

## Acceptance Criteria

- [ ] Wrangler v4+ in deploy pipeline
- [ ] All existing features still work on staging (D1, KV, R2, DO, AI bindings)
- [ ] Artifacts-backed project created successfully end-to-end on staging
- [ ] Agent can create and push files to an Artifacts repo via project chat
- [ ] Config endpoint checks both `ARTIFACTS_ENABLED` and `!!env.ARTIFACTS`
