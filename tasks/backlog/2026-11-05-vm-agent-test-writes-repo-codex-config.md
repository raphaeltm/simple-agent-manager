# vm-agent test rewrites the repository's `.codex/config.toml`

## Problem

Running `go test ./internal/server/` in `packages/vm-agent` modifies the real repository file
`.codex/config.toml`: it removes the `model_reasoning_effort` line and the
`[mcp_servers.sam-mcp]` block inside the `SAM MANAGED MCP` section. Bisected to
`TestProviderLimitRecordedFixtureCallbacks` (`internal/server/provider_limit_fixture_test.go`),
which drives `runProviderWireThroughProductionHost`. The production Codex config writer is
evidently resolving a path in the developer's checkout instead of a test temp directory.

It happens with `TMPDIR` set to the default or to a directory outside the repo, so it is not a
temp-dir leak. Anyone who runs the vm-agent suite and then `git add -A` commits a broken
`.codex/config.toml`.

## Context

Found 2026-11-05 while running Phase 4 checks for the live-steering draft PR
(branch `sam/build-draft-pr-implementing-pm2ayp`). The file is unchanged on that branch.

## Acceptance Criteria

- [ ] Identify which path the Codex config writer uses under this test and why it lands in the repo.
- [ ] The test (and any sibling using the production host) writes only under `t.TempDir()`.
- [ ] A guard test fails if `go test ./internal/server/` changes any tracked file (e.g. compares
      `git status --porcelain` before/after in CI, or asserts the writer's target is under the temp root).
