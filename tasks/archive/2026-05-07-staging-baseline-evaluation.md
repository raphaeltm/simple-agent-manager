# Staging Baseline for 2026-05-07 Evaluation

## Problem Statement

The 2026-05-07 codebase evaluation identified 133 findings across 9 tracks with a 5-wave implementation plan. Before any implementation work begins, we need a documented snapshot of the current Cloudflare staging state to support compatibility/rollback planning for D1/DO/KV/R2/Wrangler/deployment changes.

## Research Findings

- Evaluation docs at `docs/evaluations/2026-05-07-codebase-data-model-agent-readiness/`
- CF API debugging cheat sheet at `.claude/rules/32-cf-api-debugging.md`
- Staging domain: `sammy.party` (api.sammy.party, app.sammy.party)
- CF_TOKEN available with read access to D1, KV, R2, Workers, DNS

## Implementation Checklist

- [ ] Query all staging infrastructure via CF API (Workers, D1, KV, R2, DNS)
- [ ] Document D1 schema state and migration level
- [ ] Document DO bindings and migration tags from wrangler.toml
- [ ] Document data shape (row counts, status distributions)
- [ ] Document deploy pipeline health
- [ ] Check for pre-existing staging issues
- [ ] Create `staging-baseline-2026-05-07.md` with UTC timestamps and findings
- [ ] Open PR (do NOT merge)

## Acceptance Criteria

- [x] Baseline doc has command log with UTC timestamps and concrete results
- [x] Baseline identifies any pre-existing staging health issues or deploy pipeline issues
- [x] Baseline includes enough current-state detail for compatibility/rollback planning
- [x] PR opened but not merged

## References

- `docs/evaluations/2026-05-07-codebase-data-model-agent-readiness/final-report.md`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/13-staging-verification.md`
