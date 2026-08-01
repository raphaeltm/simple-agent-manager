# Repo quality visibility guard

## Problem statement

The repo already has hard quality gates, but two forms of quality debt need safer visibility:

- oversized source/test files that are already present or nearing review-unfriendly sizes;
- coverage threshold baseline drift across package Vitest configs.

This task deliberately avoids refactoring large files or raising failing thresholds. The goal is a report-only guard that can run locally and in CI without destabilizing green builds.

## Research findings

- `package.json` already exposes focused `quality:*` scripts and CI runs these under the `code-quality` job.
- `scripts/quality/check-file-sizes.ts` is an existing hard gate for non-test source files over the 800-line mandatory split threshold from `.claude/rules/18-file-size-limits.md`.
- `.claude/rules/18-file-size-limits.md` documents 500-line guidance and 800-line mandatory split for source files; tests are exempt from that hard gate but still benefit from visibility.
- `vitest.coverage.ts` centralizes coverage helper wiring while thresholds live in package configs such as `apps/api/vitest.config.ts` and `apps/web/vitest.config.ts`.
- `.specify/memory/constitution.md` requires automated quality gates and no coverage regressions, but this change must remain non-breaking.

## Implementation checklist

- [ ] Add a checked-in repo-quality baseline for current coverage thresholds and visibility budgets.
- [ ] Add a report-only script that scans oversized source/test files and coverage threshold drift.
- [ ] Add unit tests for parsing/report behavior and non-breaking defaults.
- [ ] Add a package script so the guard can be run locally and optionally from CI.
- [ ] Wire CI as report-only if safe.
- [ ] Run relevant local validation.
- [ ] Run local task/test/repo-quality critique.

## Acceptance criteria

- Running the new guard locally prints actionable visibility information.
- The guard does not fail current green builds by default.
- Coverage thresholds are compared to a checked-in baseline without increasing any package threshold.
- Oversized file visibility covers source and test files without refactoring large files.
- CI integration, if added, is non-breaking/report-only.
- PR is opened and not merged.

