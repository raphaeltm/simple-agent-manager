# Flaky vm-agent test: TestStartLocalProcessResolvesCommandFromRuntimePath fails with "text file busy"

## Problem

`packages/vm-agent/internal/acp/process_test.go` `TestStartLocalProcessResolvesCommandFromRuntimePath`
runs with `t.Parallel()`, writes a shell-script fixture with `os.WriteFile(..., 0o755)` and
then execs it. When another parallel test in the package forks a child while the fixture's write
descriptor is still open, the child inherits that descriptor. The fixture's exec then fails with
`ETXTBSY` (`fork/exec …/fixture-bin/sam-acp-path-fixture: text file busy`). This is the known Go
race, golang/go#22315.

## Context

It failed the `VM Agent Integration` CI job on PR #2974 (run 45036438198, job 137251353363,
2026-11-22), which does not touch `internal/acp`. `internal/deploy`'s Caddy reload test has hit the
same error before (tasks/archive/2026-07-11-upgrade-codex-acp-wrapper.md).

## Acceptance Criteria

- [ ] Fixture executables in vm-agent tests are written so no descriptor can leak into a concurrent
      fork: write to a temp name, close it, and `os.Rename` into place; or drop `t.Parallel()` for
      tests that write-then-exec; or retry exec on `ETXTBSY` in a test helper
- [ ] Apply the same fix to other write-then-exec fixtures (grep `os.WriteFile` with `0o755` /
      `0755` under `packages/vm-agent`, including `internal/deploy`)
- [ ] `go test -race -count=50 ./internal/acp/ -run RuntimePath` passes alongside the rest of the
      package's parallel tests
