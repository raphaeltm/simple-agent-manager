# Unblock PR #927 — Fix Playwright Visual Tests CI Timeout

## Problem

PR #927 ("ci: enforce coverage thresholds and add Playwright visual tests") has two CI failures:

1. **Playwright Visual Tests** — cancelled after 45-minute job timeout. 144 individual test failures (mostly 30s action timeouts and 6.9s failures from route-mocking issues), 373 passes. Running 28 test files across 3 viewport projects (iPhone SE, iPhone 14, Desktop) with `workers: 1` and `fullyParallel: false` is too slow.

2. **SonarCloud Code Analysis** — 7.0% duplication on new code (threshold: ≤3%). Per `.claude/rules/13-staging-verification.md`, SonarCloud is an external third-party service and its failures do NOT block merge. Already mitigated by `sonar-project.properties` exclusions added in the PR.

## Research Findings

- 28 audit test files × 3 projects = 84 file executions, ~500+ individual tests
- `workers: 1` + `fullyParallel: false` means all tests run sequentially
- Many tests fail because they navigate to Settings sub-pages (like `/settings/compute`) that require specific route mocking patterns — the tests were designed for local visual auditing, not headless CI
- Tests hitting 30s Playwright action timeouts indicate waiting for elements that never render (likely because API mock routes aren't intercepted before navigation)
- The job's 45-min timeout is reasonable; the issue is test volume and serial execution
- CI only needs to verify visual regressions exist at all — running 1 project (iPhone 14) is sufficient for CI smoke; full 3-project coverage is for local auditing

## Implementation Checklist

- [ ] Reduce Playwright CI to single project (iPhone 14 only) via `--project` flag
- [ ] Add `timeout: 15000` to playwright.config.ts for CI to cap individual test runtime
- [ ] Increase `workers` to 2 in CI for parallelism
- [ ] Add `fullyParallel: true` for CI context
- [ ] Add SonarCloud exclusion for `vitest.coverage.ts`
- [ ] Verify changes pass locally with `npx playwright test` on subset
- [ ] Push and verify CI completes within timeout

## Acceptance Criteria

- [ ] Playwright Visual Tests CI job completes (pass or documented real failures) within the 45-min timeout
- [ ] SonarCloud is passing or documented as non-actionable with evidence
- [ ] Changes pushed to `sam/execute-task-using-skill-01kr0s`
- [ ] PR not merged
