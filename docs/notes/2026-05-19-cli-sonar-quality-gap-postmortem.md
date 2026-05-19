# CLI Sonar Quality Gap Post-Mortem

## What Broke

PR #1067 merged the Go CLI foundation with SonarCloud still reporting new maintainability issues, duplicated literals, duplicated test scaffolding, and 0.0% Go coverage on new code.

## Root Cause

The CLI rewrite introduced a new Go package surface without an explicit CLI-specific quality rule. Existing Go guidance focused on the VM agent, so command parsing, command dispatch, and runner diagnostics did not have a clear standard for cognitive complexity, coverage reporting, or QA-style command-boundary tests.

The CI workflow also contained a `cli-test` job keyed to `needs.changes.outputs.cli`, but the `changes` job did not publish a `cli` output or filter. As a result, the CLI test job was not reliably enforcing the new package on PRs.

## Timeline

- 2026-05-19: PR #1067 merged the initial Go CLI foundation.
- 2026-05-19: SonarCloud reported 7 new issues, 0.0% new-code coverage, and duplicated lines in CLI test scaffolding.
- 2026-05-19: PR #1068 was opened to refactor the affected CLI code, add coverage wiring, expand tests, and add CLI-specific agent rules.

## Why It Wasn't Caught

The initial review treated the Go rewrite as a foundation change but did not add a matching process rule for the new package. Local Go tests existed, but CI was not wired to run them for `packages/cli` changes, and SonarCloud had no Go coverage report path.

The tests also covered important behavior, but duplicated request-capture setup made the suite noisier than it needed to be and created avoidable Sonar duplication.

## Class Of Bug

New package quality-gate gap: adding a new language/package surface without updating CI filters, coverage ingestion, specialist review scope, and package-specific testing expectations.

## Process Fix

PR #1068 adds:

- `.claude/rules/36-cli-quality.md` for CLI-specific implementation and review requirements.
- CLI coverage generation in `.github/workflows/ci.yml`.
- `sonar.go.coverage.reportPaths=packages/cli/coverage.out` in `sonar-project.properties`.
- CLI scope in `.claude/agents/go-specialist/GO_SPECIALIST.md` and `.agents/skills/go-specialist/SKILL.md`.
- Codex-facing CLI quality guidance in `AGENTS.md`.

Future CLI changes must include command-boundary tests, secret-redaction checks, path/payload assertions for API calls, runner state scenarios, and local/CI Go coverage evidence.
