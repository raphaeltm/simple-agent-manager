# Quality guardrail baselines for oversized files and coverage drift

**Created**: 2026-08-01
**Source**: SAM task 01KYY3N1C8JA30WS4C6BMFGBBW
**Status**: Completed

## Problem

Repo-wide review evidence shows maintainability debt that is currently easy to miss:

- several large source files are intentionally exempted from the hard file-size gate;
- test files are exempt from the mandatory split rule, but very large tests still affect review and agent context;
- package coverage thresholds are intentionally low and can drift without a clear baseline report.

This PR must make those issues visible without destabilizing CI or forcing broad refactors.

## Research findings

- `package.json` already exposes report/check scripts under `quality:*`, including `quality:file-sizes` and `test:coverage`.
- `scripts/quality/check-file-sizes.ts` enforces an 800-line hard source-file limit, skips test files, and exempts known oversized source files such as `apps/api/src/db/schema.ts` and `packages/vm-agent/internal/bootstrap/bootstrap.go`.
- `.claude/rules/18-file-size-limits.md` says tests are exempt, while source files over 800 lines require splitting unless documented.
- `vitest.coverage.ts` centralizes coverage config, while package-specific thresholds live in `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`, and package configs.
- `tasks/archive/2026-05-07-coverage-thresholds-playwright-ci.md` records historical coverage baselines and the ratchet intent.
- `.specify/memory/constitution.md` requires automated quality gates and no coverage regressions, but this task should not raise thresholds unless the suite proves green.

## Implementation checklist

- [x] Add a non-breaking repo-quality report or baseline metadata that surfaces oversized exempt source files and oversized tests.
- [x] Add coverage-threshold baseline metadata/reporting that compares package thresholds against documented/current baselines without failing CI unexpectedly.
- [x] Add narrowly scoped tests for any new or modified quality tooling.
- [x] Ensure any numeric limits are centralized/configurable constants, not scattered hardcoded values.
- [x] Run relevant quality commands locally.
- [x] Run local test-quality/repo-quality critique and address useful findings.
- [x] Create a PR on `sam/execute-task-using-skill-mfgbbw`.
- [x] Do not merge the PR.

## Acceptance criteria

- [x] Existing CI remains non-destabilized: no broad refactor, no unexpected hard failure for existing oversized files/tests.
- [x] Maintainers can run a quality command and see known oversized-file debt and coverage-threshold drift/baseline information.
- [x] Existing hard file-size enforcement for new oversized source files remains intact.
- [x] Coverage thresholds are not raised unless the full relevant suite proves green.
- [x] PR description documents local review evidence and the explicit do-not-merge constraint.

## Validation evidence

- `pnpm quality:file-sizes` passed after documenting the pre-existing oversized `apps/api/src/routes/projects/crud.ts` source file in the exemption/debt baseline.
- `pnpm quality:file-size-debt` passed and reports known oversized exempt source files plus oversized test files without failing.
- `pnpm quality:coverage-baseline` passed and reports baseline/threshold headroom, including low-headroom drift for `apps/web` line coverage.
- `pnpm quality:specialist-review:test -- scripts/quality/check-file-sizes.test.ts scripts/quality/check-coverage-threshold-baseline.test.ts` passed.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed locally.
- Local test-quality/repo-quality reviewer subagents were started but timed out without findings; manual critique found the guard useful because it enumerates existing debt while preserving hard enforcement for new oversized source files.

- PR created as draft and labeled `needs-human-review`: https://github.com/raphaeltm/simple-agent-manager/pull/1711.
- PR was not merged, per explicit task instruction.
