# Devcontainer `/etc/gitconfig.lock` Failure Post-mortem

## What Broke

Workspace provisioning failed while configuring Git credentials in the devcontainer:

```text
failed to configure git credential helper in devcontainer: exit status 255: error: could not lock config file /etc/gitconfig: File exists
```

The failing path was `ensureGitCredentialHelper()` calling `configureGitCredentialHelper()` in `packages/vm-agent/internal/bootstrap/bootstrap.go`. That function used `git config --system credential.helper ...`, which writes `/etc/gitconfig` inside the devcontainer.

## Root Cause

Git protects config writes by creating a sibling lock file. For system config, that lock is `/etc/gitconfig.lock`. The command fails when that file already exists.

Likely causes:

- A concurrent `git config --system` write from another provisioning step or devcontainer lifecycle hook.
- A prior interrupted `git config --system` invocation that left a stale lock file behind.
- Reused or partially initialized containers where `/etc/gitconfig.lock` persisted after an earlier failure.

The same failure mode also applied to `ensureGitIdentity()`, which configured `user.email` and `user.name` through separate `git config --system` writes in `packages/vm-agent/internal/bootstrap/bootstrap.go`.

## Fix

`configureGitCredentialHelper()` now delegates to `configureSystemGit()`, which:

1. Retries transient `/etc/gitconfig.lock` failures with short backoff.
2. Checks for an active `git config` process inside the container before treating the lock as stale.
3. Removes `/etc/gitconfig.lock` only after retries are exhausted and no active config writer is found.
4. Retries the original system config write after stale lock cleanup.

`ensureGitIdentity()` uses the same helper for `user.email` and `user.name`, so all system Git config writes share the same lock handling.

Regression coverage was added in `packages/vm-agent/internal/bootstrap/bootstrap_test.go` for lock-error detection and active process detection.

## Process Fix

Any new VM-agent code that writes `/etc/gitconfig` must use the shared system Git config helper instead of calling `git config --system` directly. Direct calls reintroduce the stale-lock provisioning failure.
