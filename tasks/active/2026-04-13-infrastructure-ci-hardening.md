# Infrastructure & CI Hardening

## Problem

Multiple infrastructure and CI configuration issues were flagged in a comprehensive code review. These are safe, non-breaking changes to devcontainer config, CI workflows, deployment scripts, and worker config.

## Research Findings

1. **`.devcontainer/devcontainer.json` line 16**: Go version `"1.22"` mismatches CI (`1.24`) and CLAUDE.md (`Go 1.24+`).
2. **`.github/workflows/ci.yml`**: 10 jobs lack `timeout-minutes` — a runaway job can burn CI minutes indefinitely: `lint`, `typecheck`, `test`, `build`, `deploy-scripts`, `code-quality`, `pulumi-infra`, `preflight-evidence`, `specialist-review-evidence`, `ui-compliance`.
3. **`scripts/deploy/configure-secrets.sh`**: Missing optional forwarding for analytics secrets: `SEGMENT_WRITE_KEY`, `GA4_API_SECRET`, `GA4_MEASUREMENT_ID` (referenced in CLAUDE.md analytics-engine-phase4-forwarding).
4. **`apps/api/.env.example` line 7**: `BASE_DOMAIN=simple-agent-manager.org` points at production — dangerous for local dev. Should use `workspaces.example.com`.
5. **`apps/api/.env.example` line 361**: Comment on `CODEX_REFRESH_PROXY_ENABLED` is ambiguous. The `.env.example` shows `false` as the kill-switch value, but the actual default is enabled.
6. **`apps/api/wrangler.toml` and `apps/tail-worker/wrangler.toml`**: `compatibility_date = "2025-01-01"` is over a year old. Should be `"2026-01-01"`.
7. **`.github/workflows/deploy-www.yml`, `provision-www.yml`, `teardown-www.yml`**: `PAGES_PROJECT: sam-www` is hardcoded — not fork-friendly. Should use `${{ vars.RESOURCE_PREFIX || 'sam' }}-www`.
8. **`.github/workflows/deploy-reusable.yml` line 492**: Dead step — `github.event_name == 'pull_request'` never triggers from `workflow_dispatch`. Should be removed.

## Implementation Checklist

- [ ] 1. Update Go version in `.devcontainer/devcontainer.json` from `"1.22"` to `"1.24"`
- [ ] 2. Add `timeout-minutes: 15` to all 10 CI jobs that lack it
- [ ] 3. Add optional secret forwarding blocks for `SEGMENT_WRITE_KEY`, `GA4_API_SECRET`, `GA4_MEASUREMENT_ID` in `configure-secrets.sh`
- [ ] 4. Change `BASE_DOMAIN` in `.env.example` to `workspaces.example.com`
- [ ] 5. Fix `CODEX_REFRESH_PROXY_ENABLED` comment in `.env.example`
- [ ] 6. Update `compatibility_date` to `"2026-01-01"` in both wrangler.toml files
- [ ] 7. Replace hardcoded `sam-www` with `${{ vars.RESOURCE_PREFIX || 'sam' }}-www` in 3 www workflows
- [ ] 8. Remove dead "Comment Staging URLs on PR" step from `deploy-reusable.yml`

## Acceptance Criteria

- [ ] All CI jobs have timeout protection
- [ ] Go version consistent across devcontainer and CI
- [ ] Analytics secrets are forwarded when present
- [ ] .env.example does not point at production
- [ ] Wrangler compatibility dates are current
- [ ] www workflows are fork-friendly
- [ ] No dead workflow steps remain
- [ ] CI passes with all changes
