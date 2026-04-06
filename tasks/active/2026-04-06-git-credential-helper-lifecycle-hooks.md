# Git Credential Helper Available During Devcontainer Lifecycle Hooks

## Problem

The git credential helper is currently installed AFTER `devcontainer up` completes (via `ensureGitCredentialHelper()`). This means devcontainer lifecycle hooks (`postCreateCommand`, `postStartCommand`, `postAttachCommand`) cannot authenticate to private GitHub repos — e.g., submodules, private npm/go modules, or any git operation in lifecycle hooks.

The fix: pre-generate the credential helper script on the VM host BEFORE `devcontainer up`, and bind-mount it into the container via the devcontainer override config. This makes the helper available from the very first lifecycle hook.

## Research Findings

### Current Architecture
- `ensureGitCredentialHelper()` (bootstrap.go:1524) installs the helper AFTER container is running
- `renderGitCredentialHelperScript()` (bootstrap.go:1650) generates the shell script
- 4 devcontainer-up paths exist:
  1. `ensureDevcontainerReady()` with repo config + volume mount override
  2. `ensureDevcontainerReady()` with repo config, no volume
  3. `ensureDevcontainerReady()` fallback to default
  4. `ensureDevcontainerFallback()` (lightweight mode)
  5. `runDevcontainerWithDefault()` (called by paths 3 & 4)
- `writeDefaultDevcontainerConfig()` builds a JSON config string
- `writeMountOverrideConfig()` reads merged config, adds volume mount, writes override JSON
- `handleDeleteWorkspace()` (workspaces.go:479) handles cleanup

### Key Decisions
- Host path: `/tmp/git-credential-sam-{sanitized-workspaceID}`
- Container path: `/usr/local/bin/git-credential-sam` (same as post-build path)
- Bind mount type: read-only bind mount
- File permissions: `0o700` (tighter than current `0o755`)
- GIT_CONFIG env vars via `containerEnv` in devcontainer config
- Deferred cleanup of host file if bootstrap fails

### Known Limitation
- `GIT_CONFIG_COUNT` collision: if a repo's devcontainer.json already sets `GIT_CONFIG_COUNT`, the injected value will clobber it. Tracked in `tasks/backlog/2026-03-31-git-config-count-collision.md`.

## Implementation Checklist

- [ ] Add `sanitizeWorkspaceID()` function for path traversal prevention
- [ ] Add `credentialHelperHostPath()` to return host-side path
- [ ] Add `writeCredentialHelperToHost()` to generate and write script before devcontainer up
- [ ] Add `RemoveCredentialHelperFromHost()` exported cleanup function
- [ ] Add `credentialHelperContainerEnv()` for GIT_CONFIG env vars
- [ ] Add `credentialHelperMountEntry()` for bind mount string
- [ ] Add `writeCredentialOverrideConfig()` for repos with own config but no volume
- [ ] Add `injectCredentialHelperIntoConfig()` to merge into existing devcontainer configs
- [ ] Thread `credHelperHostPath` through: `ensureDevcontainerReady`, `ensureDevcontainerFallback`, `fallbackToDefaultDevcontainer`, `runDevcontainerWithDefault`, `writeDefaultDevcontainerConfig`, `writeMountOverrideConfig`
- [ ] Update `Run()` to call `writeCredentialHelperToHost()` after git clone, pass path through
- [ ] Update `PrepareWorkspace()` similarly
- [ ] Add deferred cleanup of host file on bootstrap failure
- [ ] Tighten `ensureGitCredentialHelper()` chmod from 0o755 to 0o700
- [ ] Add `RemoveCredentialHelperFromHost()` call in `handleDeleteWorkspace()`
- [ ] Write unit tests for all new functions
- [ ] Update integration test signatures
- [ ] Verify all existing tests pass with signature changes

## Acceptance Criteria

- [ ] Git credential helper script exists on VM host at `/tmp/git-credential-sam-{id}` BEFORE `devcontainer up`
- [ ] Helper is bind-mounted into container at `/usr/local/bin/git-credential-sam`
- [ ] GIT_CONFIG env vars are set via containerEnv so git uses the helper from first lifecycle hook
- [ ] Helper is cleaned up from host on workspace deletion
- [ ] Helper is cleaned up from host if bootstrap fails
- [ ] Path traversal prevention works (sanitized workspace IDs)
- [ ] All 4 devcontainer-up paths support the credential helper mount
- [ ] Existing post-build credential helper still works (belt-and-suspenders)
- [ ] All existing tests pass
- [ ] New tests cover all new functions

## References

- PR #573 (old branch: `sam/implement-git-credential-helper-01kn1x`)
- `tasks/backlog/2026-03-31-git-config-count-collision.md`
- `packages/vm-agent/internal/bootstrap/bootstrap.go`
- `packages/vm-agent/internal/server/workspaces.go`
