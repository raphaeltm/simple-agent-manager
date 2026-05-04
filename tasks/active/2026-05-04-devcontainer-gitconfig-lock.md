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
- [ ] Deploy to staging and verify real VM provisioning.

## Acceptance Criteria

- [ ] A stale `/etc/gitconfig.lock` no longer permanently fails credential helper setup.
- [ ] Active concurrent Git config writers are not interrupted by stale-lock cleanup.
- [ ] Git identity setup receives the same stale-lock protection.
- [x] Tests or documented manual checks cover the new detection logic.
- [ ] Staging verification provisions a real VM, receives heartbeat, verifies workspace access, and cleans up test infrastructure.

## References

- `packages/vm-agent/internal/bootstrap/bootstrap.go`
- `packages/vm-agent/internal/bootstrap/bootstrap_test.go`
- `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`
- `.claude/rules/06-vm-agent-patterns.md`
