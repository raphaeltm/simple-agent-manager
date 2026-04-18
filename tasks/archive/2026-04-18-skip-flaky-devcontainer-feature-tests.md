# Skip flaky devcontainer-feature integration tests on external infrastructure failures

## Problem

`TestIntegration_InstallAgent_Devcontainer_SAMRepoConfig` and `TestIntegration_InstallAgent_RealClaudeCodeACP` in `packages/vm-agent/internal/acp/install_integration_test.go` fail intermittently because they depend on external infrastructure that SAM does not control:

- `ghcr.io/devcontainers/features/go:1` — GHCR feature registry occasionally returns a broken feature install
- `ghcr.io/devcontainers/features/github-cli:1` — the `cli.github.com/packages/githubcli-archive-keyring.gpg` download is sometimes served as a malformed/truncated file, causing `apt` to reject the keyring with `Malformed certificate in keyring`

Seen on PR #749 CI run 24605321635 (job 71950510279). Neither failure indicates a bug in SAM's agent installer.

## Fix

Detect known external-infrastructure failure patterns in `devcontainer up` output and call `t.Skip()` instead of `t.Fatalf()` when they occur. This keeps the tests honest (they still verify the installer when upstream services are healthy) without letting external CDN flakes turn CI red.

## Implementation Checklist

- [ ] Add `isExternalDevcontainerFeatureFailure(output string) bool` helper in `install_integration_test.go` that returns true for these patterns:
  - `Feature "Go" (ghcr.io/devcontainers/features/go) failed to install`
  - `Feature "GitHub CLI" (ghcr.io/devcontainers/features/github-cli) failed to install`
  - `Malformed certificate in keyring`
- [ ] In `TestIntegration_InstallAgent_Devcontainer_SAMRepoConfig`, wrap the `devcontainer up` failure path so external failures call `t.Skipf`
- [ ] In `TestIntegration_InstallAgent_RealClaudeCodeACP`, apply the same wrapping
- [ ] In `TestIntegration_InstallAgent_Devcontainer_PythonImage`, apply the same wrapping (defense in depth — shares the same buildx codepath)
- [ ] `go test -tags integration ./internal/acp/...` locally still compiles and the non-affected tests still pass
- [ ] Document the rationale in a comment above the helper

## Acceptance Criteria

1. When GHCR/GitHub CDN serves broken content, `VM Agent Integration` job reports a skip (not a failure) for the affected tests
2. When upstream services are healthy, the tests still run and fail loudly on real bugs in our installer
3. No other tests are modified

## References

- PR #749 CI run 24605321635, job 71950510279 (the failure that motivated this fix)
