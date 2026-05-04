# Observability Log-Noise Regression Guardrail

## Problem

Production log review found two observability drift issues:
1. Repeated internal ingest 401 errors on `/api/admin/observability/logs/ingest`
2. Normal VM agent lifecycle messages persisted at error severity

We need a repeatable guardrail to catch this kind of log noise during staging verification or incident review.

## Research Findings

- Quality scripts live in `scripts/quality/` and follow a pattern: standalone TypeScript files run with `tsx`, registered in root `package.json` as `quality:<name>` scripts.
- The observability D1 database stores errors with `source`, `level`, `message`, `timestamp` fields via `apps/api/src/services/observability.ts`.
- CF API access is available via `$CF_TOKEN` env var — can query D1 with SQL directly.
- The Cloudflare Workers Observability API provides raw telemetry (7-day retention) — accessible via `https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/v1/query`.
- Environment-specific IDs (account, D1 database, etc.) must come from env vars, not hardcoded values (Constitution Principle XI).
- Existing pattern in `.claude/rules/32-cf-api-debugging.md` shows the exact CF API query format for D1.

## Implementation Checklist

- [ ] Create `scripts/quality/check-observability-noise.ts` with:
  - [ ] D1 query: count errors grouped by message pattern in last N hours
  - [ ] D1 query: find "success-like" messages stored at error level (matching patterns like "started", "connected", "healthy", "running", "completed")
  - [ ] Workers telemetry query: check for repeated 401s on internal ingest path
  - [ ] Configurable via env vars: `CF_TOKEN`, `CF_ACCOUNT_ID`, `OBSERVABILITY_DB_ID`, `LOG_NOISE_LOOKBACK_HOURS` (default: 24), `LOG_NOISE_THRESHOLD` (default: 10)
  - [ ] Actionable summary output (not raw dumps) — counts, top offenders, severity flags
  - [ ] Exit code: 0 if clean, 1 if noise detected (usable as CI gate later)
- [ ] Add `quality:observability-noise` script entry to root `package.json`
- [ ] Add unit test for the analysis/summarization logic
- [ ] Add documentation section to `docs/guides/deployment-troubleshooting.md` explaining when to run it
- [ ] Update `.claude/rules/13-staging-verification.md` with a note about running the check

## Acceptance Criteria

- A repeatable command (`pnpm quality:observability-noise`) exists
- Checks both persisted D1 errors and raw Workers telemetry
- Reports actionable summaries (top repeated errors, severity mismatches)
- Flags repeated internal ingest 401s
- Flags success-like messages stored at error severity
- No hardcoded environment-specific values
- Documentation explains when to run it
- Local typecheck passes

## References

- `.claude/rules/32-cf-api-debugging.md` — CF API access patterns
- `apps/api/src/services/observability.ts` — error persistence schema
- `scripts/quality/` — existing quality check patterns
- `docs/guides/deployment-troubleshooting.md` — deployment docs
