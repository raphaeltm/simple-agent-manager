# Scheduled OSV advisory scan

## Problem

Preserve the scheduled OSV advisory integration from PR #1784 in a separate draft PR so the broader quality program can merge independently. The integration must remain parked until private SAM webhook routing is configured and tested end to end.

## Research findings

- Commit `5863929ace4e0670aecc767e640c068e35d6a959` contains the requested workflow, policy validator, advisory runner, configuration, and tests.
- Current `main` already has `scripts/quality/vitest.config.ts` and the `quality:scripts:test` root script, but does not contain the broader `ci-quality-program.test.ts` or `scripts/quality/README.md` introduced by PR #1784.
- The OSV workflow is intentionally schedule-only, fork-guarded, read-only, checksum-verifies OSV-Scanner 2.5.0, and fails closed unless both private-routing secrets are configured.
- The OSV-specific contract assertions from PR #1784 can live in a small standalone test collected by the existing quality-script Vitest configuration.
- Relevant safeguards are `.claude/rules/02-quality-gates.md`, `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/25-review-merge-gate.md`, and Constitution Principle XI.
- Staging is intentionally not applicable: the scheduled workflow cannot be exercised before private routing exists, and the task explicitly forbids staging mutation.

## Implementation checklist

- [x] Copy `.github/workflows/osv-scan.yml`, `osv-scanner.toml`, the OSV policy validator/test, and the OSV advisory runner/test faithfully from the source commit.
- [x] Add `quality:osv-policy` and `quality:osv-advisory` to the root package scripts.
- [x] Add the blocking `OSV ignore expiry policy` step to the CI `code-quality` job.
- [x] Add focused OSV documentation under `scripts/quality/README.md`, adapted to the files present on current `main`.
- [x] Add a standalone OSV workflow-contract test covering schedule-only execution, event/routing gates, secret wiring, and prohibited public artifacts or issue permissions.
- [x] Run `pnpm quality:scripts:test`, `pnpm quality:osv-policy`, `pnpm lint`, and `pnpm typecheck`.
- [x] Complete specialist review and task-completion validation.
- [ ] Open the required draft PR against `main`, wait for CI, and report results without staging or merge.

## Acceptance criteria

- The extracted files match the source commit except for the explicitly requested README adaptation and standalone contract-test extraction.
- The scheduled workflow has no `workflow_dispatch` or `pull_request` trigger, is fork-guarded, uses read-only permissions, and verifies the pinned scanner release checksum.
- Scheduled policy validation fails closed when private routing is not configured.
- Findings are routed only through the configured authenticated private webhook; no public issue or uploaded report path is introduced.
- All required local checks pass.
- A draft PR named `quality: scheduled OSV advisory scan (pending private routing config)` exists, documents the private-routing prerequisites, origin in PR #1784, intentional staging omission, and expected post-#1784 rebase conflicts.
- The PR remains draft and unmerged; staging is not deployed or mutated.

## References

- PR #1784
- Commit `5863929ace4e0670aecc767e640c068e35d6a959`
- `.github/workflows/ci.yml`
- `scripts/quality/vitest.config.ts`
- `.claude/rules/25-review-merge-gate.md`
- `.specify/memory/constitution.md` Principle XI

## Validation evidence

- `pnpm quality:scripts:test`: 22 files and 237 tests passed.
- `pnpm quality:osv-policy`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, formatting, source-contract, and `git diff --check` gates passed.
- The broad `pnpm test` run reached 6,799 API tests and reported three unrelated timeout-only failures; all three affected files then passed in isolation (3 files, 125 tests).
- Task completion, security, environment, documentation, constitution, and test-quality reviews completed. No CRITICAL/HIGH blocker applies to creating the requested parked draft.
- Staging was intentionally skipped and not mutated, per the task's hard constraint.
- Draft PR creation and CI reporting remain the Phase 7 lifecycle step; the PR must remain draft and unmerged.
