# Coverage Thresholds & Playwright Visual Tests in CI

**Created**: 2026-05-07
**Source**: Evaluation findings F-022, F-027
**Status**: Active

## Problem

1. **F-022**: Coverage thresholds are not enforced. Test coverage can silently regress without CI catching it.
2. **F-027**: Playwright visual tests exist (30 spec files) but are not run in CI. UI regressions can ship without automated visual audit detection.

## Implementation Checklist

- [x] Measure current coverage baselines across all packages
- [x] Add coverage thresholds to `apps/api/vitest.config.ts`
- [x] Add coverage thresholds to `apps/web/vitest.config.ts`
- [x] Add coverage thresholds to `packages/shared/vitest.config.ts`
- [x] Add coverage thresholds to `packages/providers/vitest.config.ts`
- [x] Add `web-ui` path filter to CI `changes` job
- [x] Add `playwright-visual` CI job (conditional on web-ui changes)
- [x] Increase Playwright webServer timeout for CI (180s vs 60s local)
- [x] Verify all coverage thresholds pass locally
- [x] Verify lint passes

## Coverage Baselines (measured 2026-05-07)

| Package | Statements | Branches | Functions | Lines | Threshold (Stmts) |
|---------|-----------|----------|-----------|-------|--------------------|
| API | 48.72% | 44.01% | 47.24% | 49.07% | 45% |
| Web | 56.14% | 52.31% | 49.28% | 57.89% | 53% |
| Shared | 86.94% | 34.69% | 63.15% | 86.71% | 83% |
| Providers | 74.59% | 75.36% | 81.96% | 75.86% | 71% |

Thresholds set ~3-5% below current baselines to prevent regressions while allowing for minor fluctuations. Ratchet upward as coverage improves.

## Ratchet Plan

When coverage improves significantly (>5% above threshold), update the threshold in the relevant `vitest.config.ts` to lock in the gains. This prevents regression to the old baseline while allowing gradual improvement.

## Acceptance Criteria

- [x] `pnpm test:coverage` fails if any package drops below its threshold
- [x] CI `Test` job enforces thresholds (via Vitest config, no additional CI change needed)
- [x] CI `Playwright Visual Tests` job runs existing visual audits when web/UI files change
- [x] Playwright screenshots uploaded as artifacts on failure for debugging
