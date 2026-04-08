# Fix git-credential-sam permissions for non-root users

## Problem

`git-credential-sam` is installed at `/usr/local/bin/git-credential-sam` with owner `root:root` and permissions `0700` (`rwx------`). When the devcontainer runs as a non-root user (e.g., `vscode` with uid 1000), the binary is completely inaccessible. Every git operation requiring authentication fails with:

```
/usr/local/bin/git-credential-sam get: Permission denied
```

This affects repos with submodules (which need auth for `git submodule update --init`), private repos needing `git push`/`git fetch`, and any non-root user workflow that requires git authentication.

## Root Cause

Commit `ac638c06` ("make git credential helper available during devcontainer lifecycle hooks") intentionally tightened permissions from `0755` to `0700` as a security hardening measure. However, this didn't account for non-root container users.

The security concern (protecting the callback token in the script) is moot because the same token is already exposed via:
- `GIT_CONFIG_VALUE_0` environment variable
- `/etc/sam/env` file

Both are readable by the container user. Restricting the binary to `0700` doesn't protect the token; it just breaks non-root users.

## Why It Usually Works

1. SAM's agent processes (Claude Code) get `GH_TOKEN` injected directly via `docker exec` env vars — they don't depend on `git-credential-sam`.
2. The initial clone uses an embedded token in the HTTPS URL, so clone always succeeds.
3. The credential helper is only needed for subsequent git operations by the container user (push, fetch private repos, submodule init).

## Research Findings

Three locations in `packages/vm-agent/internal/bootstrap/bootstrap.go` use `0700`:

1. **Line ~1674**: `os.Chmod(tempPath, 0o700)` — temp file before `docker cp`
2. **Line ~1685**: `docker exec -u root chmod 0700 installPath` — inside container after copy
3. **Line ~1884**: `os.OpenFile(hostPath, ..., 0o700)` — host-side file for bind-mount

Test file `bootstrap_test.go` also references `0o700` in test assertions (line ~2151).

## Implementation Checklist

- [ ] Change `0o700` to `0o755` in `ensureGitCredentialHelper()` temp file chmod (line ~1674)
- [ ] Change `"0700"` to `"0755"` in `ensureGitCredentialHelper()` docker exec chmod (line ~1685)
- [ ] Change `0o700` to `0o755` in `writeCredentialHelperToHost()` OpenFile call (line ~1884)
- [ ] Update test assertion in `TestRemoveCredentialHelperFromHost` that uses `0o700` (line ~2151)
- [ ] Search for any other `0700` references related to credential helper and fix them
- [ ] Run Go tests: `cd packages/vm-agent && go test ./internal/bootstrap/...`

## Acceptance Criteria

- [ ] `git-credential-sam` binary inside containers is installed with `0755` permissions
- [ ] Host-side credential helper file is created with `0755` permissions
- [ ] Non-root container users (e.g., `vscode`) can execute `git-credential-sam`
- [ ] All existing Go tests pass
- [ ] No regression for root-user containers

## References

- Bug report from user working with submodules in a `remoteUser: vscode` devcontainer
- Commit `ac638c06` introduced the `0755` -> `0700` change
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — primary file
- `packages/vm-agent/internal/bootstrap/bootstrap_test.go` — test file
