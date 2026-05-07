# P2-04: Add Playwright Visual Tests to CI

**Phase**: 2 (Testing Foundation)
**Priority**: P1
**Risk Level**: Low — CI config addition
**Effort**: M (1 day)
**Source Findings**: F-027 (Track 6: Testing)
**Recommended Skill(s)**: `$ui-ux-specialist`, `$test-engineer`

## Scope

30 Playwright visual audit specs exist in `apps/web/tests/playwright/` but are not run in CI. Visual regressions are only caught if agents manually run tests. This packet adds a CI job that runs Playwright visual tests against a Vite preview build with mock data.

## Files Likely Touched

- `.github/workflows/ci.yml` — add new `playwright-visual` job
- `apps/web/playwright.config.ts` — may need CI-specific config adjustments
- Possibly `apps/web/package.json` — add `test:playwright` script if not present

## Compatibility Constraints

- Must run after `pnpm build` (needs Vite preview build)
- Should not require staging access — runs against local preview with mock data
- Must handle headless browser setup in CI environment (install Playwright browsers)
- Sequence after P2-01 since both modify CI workflow

## Automated Tests to Add/Run

- New CI job runs: `npx playwright test` in `apps/web/`
- All 30 existing visual audit specs should pass

## Manual Staging Verification

- N/A — CI infrastructure only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- Visual regressions caught automatically in CI
- Layout bugs (overflow, clipping, broken responsive) blocked before merge

## Visible Behavior Changes

- None to end users
- CI has an additional job for visual testing

## Rollback Notes

- Remove the CI job. No state to clean up.

## Acceptance Criteria

- [ ] CI job runs all Playwright visual tests against Vite preview build
- [ ] All 30 existing specs pass in CI
- [ ] Headless browser setup works in CI environment
- [ ] Job runs in parallel with other CI jobs (not blocking the critical path excessively)

## Links

- Track report: `tracks/06-testing-experiments.md` (Section: Playwright Visual Tests)
- Finding: F-027 in `findings-index.md`
- Related: `.claude/rules/17-ui-visual-testing.md`
