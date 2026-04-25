# Upgrade Wrangler to v4+ to Unblock Artifacts Feature

**Created**: 2026-04-25
**Priority**: HIGH — Artifacts-backed projects are broken in production

## Problem

The `[[artifacts]]` binding in `wrangler.toml` requires Wrangler v4+, but the deploy pipeline uses Wrangler v3.114.17 (from `pnpm-workspace.yaml` catalog). Wrangler v3 silently ignores the `[[artifacts]]` binding, so at runtime `env.ARTIFACTS` is `undefined`, causing "Artifacts binding is not configured" errors for every user who tries to create an Artifacts-backed project.

Additionally, the config endpoint at `apps/api/src/index.ts:336` had its binding check removed (only checks `ARTIFACTS_ENABLED`, not `!!env.ARTIFACTS`), which masks the real problem in the UI.

## Research Findings

### Key Files
- `pnpm-workspace.yaml:26` — catalog entry `wrangler: 3.114.17`
- `apps/api/wrangler.toml:60-62` — `[[artifacts]]` binding definition
- `apps/api/src/index.ts:335-337` — config endpoint missing binding check
- `scripts/deploy/sync-wrangler-config.ts:124,133,247` — already handles artifacts extraction
- `.github/workflows/deploy-reusable.yml` — deploy workflow with KV/R2 commands

### Wrangler v4 Breaking Changes (from migration guide)
1. **KV/R2 commands default to local** — `wrangler kv key put/get` and `wrangler r2 object put/get` now query locally by default. Must add `--remote` flag for remote operations.
2. **esbuild v0.24** — upgraded from 0.17.19. Dynamic wildcard imports now auto-include matching files. Low risk for this codebase (no wildcard dynamic imports).
3. **Node.js 16 dropped** — we use Node 22, no impact.
4. **Legacy assets removed** — we don't use legacy assets, no impact.

### KV/R2 Commands Needing `--remote`
- `deploy-reusable.yml:452` — `wrangler kv key put "trials:enabled"` — needs `--remote`
- `deploy-reusable.yml:507-508` — `wrangler r2 object put` for VM agent binaries — needs `--remote`
- `deploy-reusable.yml:180` — `wrangler r2 bucket create` — check if needs flag

### What's Already Done
- `sync-wrangler-config.ts` already extracts and forwards `artifacts` binding
- `check-wrangler-bindings.ts` quality check doesn't check for artifacts (OK — it's optional)
- The feature code is complete (DB migration, API routes, UI, git token endpoint, cloud-init)

## Implementation Checklist

- [x] 1. Upgrade `wrangler` version in `pnpm-workspace.yaml` catalog from `3.114.17` to `4.85.0`
- [x] 2. Run `pnpm install` to update lockfile
- [x] 3. Add `--remote` flag to KV/R2 commands in `deploy-reusable.yml`:
  - `wrangler kv key put` (line ~452) — added `--remote`
  - `wrangler r2 object put` (lines ~507-508) — added `--remote`
  - `wrangler r2 bucket create` (line ~180) — management API call, no `--remote` needed
- [x] 4. Restore binding check in config endpoint (`apps/api/src/index.ts:336`):
  - Changed to: `c.env.ARTIFACTS_ENABLED === 'true' && !!c.env.ARTIFACTS`
- [x] 5. Run `pnpm typecheck` — all 16 tasks pass
- [x] 6. Run `pnpm lint` — 0 errors, 473 pre-existing warnings
- [x] 7. Run `pnpm test` — 1958 tests pass
- [x] 8. Run `pnpm build` — all 9 build tasks pass

## Acceptance Criteria

- [ ] Wrangler v4+ used in deploy pipeline (catalog version updated)
- [ ] All existing features still work on staging (D1, KV, R2, DO, AI bindings)
- [ ] KV/R2 CLI commands in deploy workflow use `--remote` flag
- [ ] Config endpoint checks both `ARTIFACTS_ENABLED` and `!!env.ARTIFACTS`
- [ ] CI passes (lint, typecheck, test, build)

## References

- Post-mortem: `docs/notes/2026-04-25-artifacts-broken-merge-postmortem.md`
- Rule: `.claude/rules/30-never-ship-broken-features.md`
- Wrangler v4 migration: https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/
