# Workspace Clone Directory Should Use Repository Name

## Summary

When a workspace is provisioned, the repository is cloned into a directory named after the workspace ID (a ULID), e.g. `/workspace/01ARZ3NDEKTSV4RRFFQ69G5FAV`. This is confusing — the directory should be named after the repository instead, e.g. `/workspace/my-cool-project`.

## Current Behavior

- `workspaceDirForRuntime()` in `workspace_routing.go:252-269` builds the path as `{baseDir}/{workspaceID}`
- `git clone` in `bootstrap.go:454` clones directly into that workspace-ID-named directory
- A `repositoryDirName()` helper already exists in `workspace_provisioning.go:257-312` that extracts the repo name from a URL (strips `.git`, takes last path segment, sanitizes) — but it's only used for legacy directory recovery, not new workspaces

## Desired Behavior

- Clone directory should be named after the repository: `/workspace/my-cool-project`
- The workspace ID should NOT appear in the directory path visible to the user
- If two workspaces on the same node use the same repo name, disambiguate (e.g. append a short suffix)

## Implementation Notes

### Key Files

| File | What to Change |
|------|---------------|
| `packages/vm-agent/internal/server/workspace_routing.go` | `workspaceDirForRuntime()` — use repo name instead of workspace ID |
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | Clone target path uses the workspace dir |
| `packages/vm-agent/internal/server/workspace_provisioning.go` | `repositoryDirName()` already exists — promote from legacy to primary |

### Considerations

- The `repositoryDirName()` function already does URL parsing, `.git` stripping, and sanitization — reuse it
- Need to handle name collisions when multiple workspaces clone the same repo on one node
- Devcontainer working directory (`Cwd` in ACP sessions) derives from this path — verify it still works
- Terminal sessions and file explorer paths will reflect the new directory name
- Existing running workspaces should not be disrupted (backward compat via `legacyWorkspaceDir()`)

## Open Questions

- Should the directory be `{baseDir}/{repoName}` or `{baseDir}/{workspaceID}/{repoName}`? The former is cleaner but the latter avoids collision issues.
- What happens if the repository field is empty or malformed?
