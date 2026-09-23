# Prevent devcontainer `/etc/gitconfig.lock` provisioning failures

## Problem

Workspace provisioning can fail while configuring Git credentials in a devcontainer with:

```text
failed to configure git credential helper in devcontainer: exit status 255: error: could not lock config file /etc/gitconfig: File exists
```

The VM agent writes system Git config in the devcontainer for the credential helper and Git identity. If `/etc/gitconfig.lock` is left behind by a concurrent or interrupted `git config --system` write, provisioning fails even though the lock may be stale.

## Research Findings

- `ensureGitCredentialHelper()` in `packages/vm-agent/internal/bootstrap/bootstrap.go` configures `credential.helper` through `git config --system`.
- `ensureGitIdentity()` in `packages/vm-agent/internal/bootstrap/bootstrap.go` separately configures `user.email` and `user.name` through `git config --system`.
- The pre-mounted credential helper and `GIT_CONFIG_*` container env are still needed for devcontainer lifecycle hooks, but the post-build system config path is still needed for non-shell Git consumers and long-lived runtime behavior.
- The same lock-file failure mode applies to all system Git config writes in the devcontainer, not only credential helper setup.
- Related rules:
  - `.claude/rules/06-vm-agent-patterns.md`
  - `.claude/rules/02-quality-gates.md`
  - `.claude/rules/10-e2e-verification.md`

## Implementation Checklist

- [x] Add shared VM-agent helper for system Git config writes inside devcontainers.
- [x] Retry transient `/etc/gitconfig.lock` failures.
- [x] Detect whether a `git config` process is still active before removing a lock file.
- [x] Remove stale `/etc/gitconfig.lock` only after retries are exhausted and no active writer is detected.
- [x] Use the shared helper for `credential.helper`.
- [x] Use the shared helper for `user.email` and `user.name`.
- [x] Add regression tests for lock-error detection and active process detection.
- [x] Document the root cause and prevention in a post-mortem.
- [x] Update VM-agent process rules to prevent future direct `git config --system` writes.
- [x] Run available local validation (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; Go toolchain unavailable locally).
- [ ] Run specialist review.
- [x] Deploy to staging and verify real VM provisioning of the fixed credential-helper path.

## Acceptance Criteria

- [x] A stale `/etc/gitconfig.lock` no longer permanently fails credential helper setup.
- [x] Active concurrent Git config writers are not interrupted by stale-lock cleanup.
- [x] Git identity setup receives the same stale-lock protection.
- [x] Tests or documented manual checks cover the new detection logic.
- [x] Staging verification provisions a real VM, receives heartbeat, verifies the devcontainer credential-helper path, and cleans up test infrastructure.

## Validation Evidence

- Local validation: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed. `go test ./internal/bootstrap` could not run locally because the Go toolchain is not installed in this workspace.
- Staging deploy: GitHub Actions run `25306910306` passed, including VM-agent build/upload and smoke tests.
- Live VM verification:
  - Workspace `01KQRZCKSBG9RBM0RRKYQ7FM35` on node `01KQRZCKBTE39F7G6BZ7SRM5ZM` reached a healthy node heartbeat; VM-agent logs showed `Configured git credential helper in devcontainer` with no `gitconfig` lock errors.
  - Workspace `01KQS0XENVY1AKJM28RGB88FN2` on node `01KQS0XE810P3B7V8K8595YE1T` repeated the same credential-helper success on a fresh node.
  - Both workspaces entered `recovery` because the tested projects used devcontainer fallback; nodes/workspaces were deleted after verification and staging returned to zero nodes.
- Live app regression: token login, `/health`, dashboard, projects, settings, and `/api/projects?limit=5` passed via Playwright with no console/page errors.

## References

- `packages/vm-agent/internal/bootstrap/bootstrap.go`
- `packages/vm-agent/internal/bootstrap/bootstrap_test.go`
- `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`
- `.claude/rules/06-vm-agent-patterns.md`
