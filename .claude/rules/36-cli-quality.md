---
paths:
  - "packages/cli/**"
  - "docs/cli.md"
  - ".github/workflows/ci.yml"
  - "sonar-project.properties"
---

# CLI Quality Bar

## Rule

Changes to `packages/cli` MUST meet the same standard as a user-facing product surface: idiomatic Go, clear command contracts, low static-analysis noise, and tests that read like a QA plan.

## Required Steps

When modifying the SAM CLI:

1. **Keep command behavior explicit**: every command, flag, exit code, output mode, and intentionally reserved future command must have an observable test.
2. **Use injectable boundaries**: HTTP, filesystem/env lookup, stdin/stdout/stderr, and host command execution must stay behind small interfaces so tests can exercise behavior without shelling out or reaching the network.
3. **Treat static analysis as a design signal**: SonarCloud findings for cognitive complexity, duplication, ignored errors, insecure defaults, and uncovered production code must be fixed in the PR unless a human explicitly approves a documented exception.
4. **Generate Go coverage in CI**: CLI tests must run with a coverage profile, and Sonar must know the report path. A PR that changes CLI production code without CLI coverage evidence is incomplete.
5. **Write QA-quality tests**: prefer named scenarios, table tests for parser matrices, boundary payload assertions for API calls, redaction checks for secrets, and failure cases that prove the CLI gives actionable errors.
6. **Avoid clever parsing shortcuts**: argument parsing must remain readable and deterministic. If a command grows nested branches, split it into focused helpers before it trips cognitive-complexity gates.
7. **No fake harness/runner behavior**: runner and harness commands may be reserved, but they must fail clearly until the real control-plane contract exists.

## Minimum Test Matrix

Every meaningful CLI change should consider:

- Help and unknown command behavior
- Global flag placement and project scoping
- Text and JSON output for user-visible commands
- Authentication config precedence, path resolution, file permissions, and secret redaction
- API request method, path escaping, headers, payload shape, error parsing, and invalid JSON handling
- Runner checks with ready, warning-only, and hard-failure host states

## Review Checklist

Before opening or merging a CLI PR:

- [ ] `go test -race -coverprofile=coverage.out -covermode=atomic ./...` passes in `packages/cli`
- [ ] `go tool cover -func=coverage.out` has been reviewed for production files touched
- [ ] SonarCloud new issues are zero or explicitly explained with human approval
- [ ] Tests assert behavior at the command boundary, not just helper return values
- [ ] Secrets never appear in stdout, stderr, errors, snapshots, or test failure messages
