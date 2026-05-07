# P2-01: Enforce Coverage Thresholds

**Phase**: 2 (Testing Foundation)
**Priority**: P1
**Risk Level**: Low — adds CI enforcement, no behavior changes
**Effort**: S (4-8 hours)
**Source Findings**: F-022 (Track 6: Testing), F-024 (Track 8: Constitution Principle II)
**Recommended Skill(s)**: `$test-engineer`

## Scope

No vitest config in the monorepo enforces coverage thresholds. Coverage can silently regress to any level. This packet adds `coverage.thresholds` to all vitest configs, starting at current reality and ratcheting upward.

## Files Likely Touched

- `apps/api/vitest.config.ts` — add thresholds
- `apps/api/vitest.workers.config.ts` — add thresholds
- `apps/web/vitest.config.ts` — add thresholds
- `packages/*/vitest.config.ts` — add thresholds for each package
- `.github/workflows/ci.yml` — ensure `pnpm test:coverage` enforces thresholds

## Compatibility Constraints

- Initial thresholds must match current reality — run `pnpm test:coverage` first to establish baselines
- Thresholds should be at or slightly below current levels (ratchet strategy)
- Critical paths (auth, credential handling, VM provisioning) may get separate, higher thresholds

## Automated Tests to Add/Run

- `pnpm test:coverage` — must pass with all new thresholds
- Verify CI fails when coverage drops below threshold (test with a temporary threshold increase)

## Manual Staging Verification

- N/A — CI/config change only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- CI fails if coverage regresses below established thresholds
- Baseline coverage numbers documented

## Visible Behavior Changes

- None to end users
- CI may fail on PRs that reduce coverage below thresholds

## Rollback Notes

- Remove `thresholds` blocks from vitest configs. No state to clean up.

## Acceptance Criteria

- [ ] Every vitest config has `coverage.thresholds` in the `coverage` block
- [ ] `pnpm test:coverage` passes with all thresholds
- [ ] Baseline coverage numbers documented (in PR description or task file)
- [ ] Initial thresholds match current reality (not aspirational)
- [ ] CI enforces thresholds on PRs

## Links

- Track report: `tracks/06-testing-experiments.md` (Section 6.1.3)
- Track report: `tracks/08-architecture-debt.md` (FINDING-8B2)
- Finding: F-022 in `findings-index.md`
- Existing backlog: `tasks/backlog/2026-03-03-improve-test-infrastructure.md`
