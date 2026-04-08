# Use per-workspace directories for credential helper host files

## Problem

The credential helper scripts are written to a flat `/tmp/git-credential-sam-<workspaceID>` path on the host. On multi-workspace nodes (up to 3 workspaces per host), all scripts are world-readable with `0755` permissions. A process in workspace A's container could theoretically read workspace B's credential helper script from the shared `/tmp` directory, extracting workspace B's callback token.

This is a pre-existing concern (not introduced by the 0700->0755 fix) since the token was already accessible via environment variables to container users. However, using per-workspace directories would add defense-in-depth.

## Proposed Fix

Place each workspace's credential helper in its own `0700` directory:

```go
func credentialHelperHostPath(workspaceID string) string {
    dir := "/tmp/sam-ws-" + sanitizeWorkspaceID(workspaceID)
    return filepath.Join(dir, "git-credential")
}
```

Create the directory with `os.MkdirAll(dir, 0o700)` before writing the file. The `0700` parent directory (owned by root) prevents other users from traversing into it, while the file inside can be `0755` for bind-mount accessibility.

## Acceptance Criteria

- [ ] Credential helper files stored in per-workspace directories under `/tmp`
- [ ] Parent directory has `0700` permissions
- [ ] Bind-mount updated to reference the new path
- [ ] `RemoveCredentialHelperFromHost` cleans up the directory
- [ ] Tests updated

## References

- Security audit finding from PR fixing git-credential-sam permissions
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — `credentialHelperHostPath()`
