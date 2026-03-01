# Environment-Independent Deployment Pipeline

**Created**: 2026-03-01
**Status**: In Progress
**PR**: #230

## Goal

Make the deployment pipeline fully environment-independent:
- `wrangler.toml` files have no `[env.*]` sections checked in
- `sync-wrangler-config.ts` generates complete env sections at deploy time
- A single reusable GitHub Actions workflow serves all environments
- Fork-friendly: new environments via GitHub Environment vars/secrets

## Checklist

- [x] Extend `scripts/deploy/types.ts` with DO, AI, tail_consumers, migrations types
- [x] Add `tailWorkerName()` to `scripts/deploy/config.ts`
- [x] Rewrite `sync-wrangler-config.ts` to generate complete env sections for both workers
- [x] Remove `[env.*]` sections from `apps/api/wrangler.toml`
- [x] Remove `[env.*]` sections from `apps/tail-worker/wrangler.toml`
- [x] Create `.github/workflows/deploy-reusable.yml` (reusable workflow)
- [x] Convert `.github/workflows/deploy.yml` to thin caller
- [x] Create `.github/workflows/deploy-staging.yml` as thin caller
- [x] Rewrite `scripts/quality/check-wrangler-bindings.ts` for new invariants
- [x] Update `CLAUDE.md` Wrangler Binding Rule
- [x] Update `.claude/rules/07-env-and-urls.md`
- [ ] Run quality checks locally
- [ ] Push and verify CI passes
- [ ] Verify staging deploy succeeds

## Key Design Decisions

1. **Conditional tail_consumers**: Sync script checks if tail worker exists via CF API. On first deploy, omits `tail_consumers` from API config, deploys tail worker, then re-syncs and re-deploys API with `tail_consumers`.

2. **Static bindings from top-level**: DO, AI, and migrations are identical across environments. The sync script copies them from the top-level wrangler.toml config.

3. **Reusable workflow**: Single `.github/workflows/deploy-reusable.yml` with `workflow_call`. Thin callers for production (push to main) and staging (PRs).

## Notes

- The `[triggers]` section (crons) is inherited by Wrangler automatically — no special handling needed.
- `tail_consumers` is intentionally absent from top-level config because it breaks Vitest (Cloudflare issue #9343).
