# Relax Runtime Config File Path Restrictions

**Created**: 2026-02-22
**Priority**: High
**Effort**: Medium
**Tags**: `business-logic-change`, `cross-component-change`, `security-sensitive-change`

## Problem

The project runtime config file path validation currently rejects absolute paths and any path containing `.` or `..` segments. This means users can only place files relative to the container's working directory (e.g., `/workspaces/repo/`). The error messages are:

- `"path must be relative"` — rejects any path starting with `/`
- `"path must not contain empty, dot, or dot-dot segments"` — rejects `.` and `..`

This restriction was added as a directory traversal prevention measure, but it's overly conservative given our actual architecture. It prevents legitimate and common use cases where tools expect config files at specific absolute paths inside the container.

## Why the Current Restriction Is Wrong

The original rationale was to prevent directory traversal attacks — e.g., `../../etc/passwd` escaping a sandbox boundary. But our architecture doesn't have the vulnerability this restriction guards against:

1. **Files are injected into the devcontainer, not the VM host.** The VM agent runs `docker exec -i {containerID} sh -c "cat > {path}"` to write files inside the running container. The injection target is already sandboxed.
2. **No bind mounts expose the host filesystem.** The git repo is cloned into a Docker volume. There are no live file mounts between the VM host and the container.
3. **The devcontainer is ephemeral and single-tenant.** Each workspace gets its own container. There's nothing to "escape to" — the container IS the trust boundary.
4. **An absolute path inside the container can't escape the container.** Writing to `/home/node/.npmrc` inside the container only affects the container.

The restriction effectively limits files to the repo directory, which defeats the primary purpose of runtime config files: placing secrets and configuration in locations outside the repo tree where tools expect to find them.

## Use Cases Blocked by Current Restriction

| Tool / Use Case | Expected Path | Currently Blocked? |
|----------------|---------------|-------------------|
| npm/yarn auth | `~/.npmrc` or `/home/node/.npmrc` | Yes (absolute) |
| GitHub CLI auth | `~/.config/gh/hosts.yml` | Yes (absolute) |
| SSH keys | `~/.ssh/id_rsa`, `~/.ssh/config` | Yes (absolute) |
| Git config | `~/.gitconfig` | Yes (absolute) |
| Docker config | `~/.docker/config.json` | Yes (absolute) |
| pip config | `~/.pip/pip.conf` | Yes (absolute) |
| AWS credentials | `~/.aws/credentials` | Yes (absolute) |
| GCP credentials | `~/.config/gcloud/application_default_credentials.json` | Yes (absolute) |
| Generic dotfiles | `~/.bashrc`, `~/.zshrc` additions | Yes (absolute) |
| Apt sources | `/etc/apt/sources.list.d/custom.list` | Yes (absolute) |

Relative paths into the repo (like `.env`, `.env.local`, `config/settings.json`) should continue to work as they do today.

## Current Implementation

### API validation (`apps/api/src/routes/projects.ts`)

```typescript
function normalizeProjectFilePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw errors.badRequest('path must be relative');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw errors.badRequest('path must not contain empty, dot, or dot-dot segments');
  }
  return segments.join('/');
}
```

### VM agent injection (`packages/vm-agent/internal/bootstrap/bootstrap.go`)

```go
func normalizeProjectRuntimeFilePath(raw string) (string, error) {
    // Rejects absolute paths and .. segments
    // Resolves path relative to ContainerWorkDir
}
```

Files are written via `docker exec` into the devcontainer:
```
docker exec -u root -i {containerID} sh -c "mkdir -p '{dir}' && cat > '{path}'"
```

## Proposed Change

### Allow absolute paths

- Remove the `startsWith('/')` rejection in the API
- Allow paths like `/home/node/.npmrc` or `/etc/some-config`
- On the VM agent side, if the path is absolute, use it as-is inside the container (no prepending of `ContainerWorkDir`)
- If the path is relative, continue resolving it relative to `ContainerWorkDir` as today

### Keep basic sanitization

- Still reject `..` segments — even though the container is a sandbox, there's no legitimate reason to use `..` in a config file path and it signals confusion
- Still reject invalid characters (`\ : * ? " < > |`)
- Still reject empty paths and empty segments

### Support home directory expansion

- Consider supporting `~/` prefix as shorthand for the container user's home directory
- The VM agent would expand `~` to the appropriate home directory (e.g., `/home/node`, `/home/vscode`, `/root`) based on the devcontainer's remote user
- This makes paths portable across different devcontainer base images

### File permissions

- Research whether certain paths need specific ownership or permissions (e.g., `~/.ssh/id_rsa` must be `600`)
- Consider adding an optional `mode` field to the file config, or apply sensible defaults based on path patterns (e.g., anything under `.ssh/` gets `600`)

## Changes Required

| Component | File | Change |
|-----------|------|--------|
| API validation | `apps/api/src/routes/projects.ts` | Relax `normalizeProjectFilePath()` to allow absolute paths |
| Shared types | `packages/shared/src/types.ts` | Possibly add optional `mode` field to `UpsertProjectRuntimeFileRequest` |
| VM agent path handling | `packages/vm-agent/internal/bootstrap/bootstrap.go` | Update `normalizeProjectRuntimeFilePath()` to handle absolute paths; expand `~` |
| VM agent injection | `packages/vm-agent/internal/bootstrap/bootstrap.go` | Use absolute paths as-is in `docker exec`, expand `~` to home dir |
| Frontend | `apps/web/src/` | Update any client-side validation or path hints in the project settings UI |
| Tests | Various | Update unit tests for new path validation rules |

## Research To Do

- How do other devcontainer-based tools handle file injection at arbitrary paths? (GitHub Codespaces secrets, Gitpod env handling, DevPod)
- What file permission modes are needed for common secret paths (`~/.ssh`, `~/.docker`, etc.)?
- How to reliably determine the devcontainer user's home directory for `~` expansion (inspect container, use `remoteUser` from devcontainer.json, etc.)

## Related

- `tasks/backlog/2026-02-18-project-runtime-env-and-files.md` — original feature spec
- `tasks/backlog/2026-02-17-devcontainer-remote-user-detection.md` — detecting the devcontainer user (relevant for `~` expansion)
