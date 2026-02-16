# Devcontainer Volume-Based Workspace Storage

**Status:** backlog
**Priority:** medium
**Estimated Effort:** 1-2 weeks
**Created:** 2026-02-16

## Problem Statement

SAM currently clones repositories on the **host VM** (`/workspace/<repo>/`) and bind-mounts them into devcontainers (`/workspaces/<repo>/`). This causes several problems:

### 1. Permission Failures Break Devcontainer Lifecycle Hooks

The devcontainer CLI bind-mounts only the repo subdirectory. The parent `/workspaces/` inside the container comes from the container image and is owned by `root:root` (mode 755). When the container runs as a non-root user (e.g., `node` in `typescript-node` images), lifecycle hooks like `postCreateCommand` cannot create sibling directories under `/workspaces/`.

**Concrete example:** Our own `.devcontainer/devcontainer.json` sets `CLAUDE_CONFIG_DIR=/workspaces/claude-home`. The `postCreateCommand` fails with `mkdir: cannot create directory '/workspaces/claude-home': Permission denied`, causing the VM agent to discard the fully-built container and fall back to a bare default image — losing all configured features (Go, Docker-in-Docker, etc.) and skipping all lifecycle hooks.

### 2. Complex Permission Normalization Dance

The VM agent runs a two-phase permission fix:
1. **Pre-devcontainer:** `chmod -R a+rwX` on the host workspace dir (so hooks can access the bind mount)
2. **Post-devcontainer:** `chown -R <container-uid>:<container-gid>` on the host workspace dir

This is fragile — it only covers the bind-mounted directory, not the container's `/workspaces/` parent, and it requires resolving the container user's UID/GID via `docker exec`.

### 3. Misalignment with Industry Practice

All major cloud development platforms use clone-inside-container for remote environments:

| Platform | Approach |
|----------|----------|
| GitHub Codespaces | Clone inside container |
| Gitpod/Ona | Clone inside container |
| DevPod (remote) | Sync/clone into container |
| Coder (Envbuilder) | Clone into persistent Docker volume |
| **SAM (current)** | **Host clone + bind mount** |

The bind-mount pattern is designed for local development where a host IDE needs file access. SAM accesses all files via `docker exec` — the bind mount provides no benefit.

### 4. Host/Container Path Confusion

The `/workspace/` (host) vs `/workspaces/` (container) distinction is a source of bugs and confusion throughout the codebase. Functions like `deriveContainerWorkDir()` exist solely to map between these two paths.

## Proposed Solution

Replace the host-clone + bind-mount model with a **named Docker volume** + **clone-inside-container** model, matching the Coder Envbuilder pattern.

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  HETZNER VM HOST                                                │
│                                                                 │
│  vm-agent (native Go binary, systemd, root)                     │
│  Docker daemon                                                  │
│                                                                 │
│  Named Docker volumes:                                          │
│    sam-ws-<workspace-id>  →  persists across container rebuilds │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  DEVCONTAINER A                                           │  │
│  │                                                           │  │
│  │  /workspaces/              ← volume mount (sam-ws-abc123) │  │
│  │      └── my-repo/          ← git clone (inside container) │  │
│  │      └── claude-home/      ← writable by container user   │  │
│  │                                                           │  │
│  │  Container user owns everything in /workspaces/            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  DEVCONTAINER B                                           │  │
│  │                                                           │  │
│  │  /workspaces/              ← volume mount (sam-ws-def456) │  │
│  │      └── other-repo/       ← git clone (inside container) │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **One named volume per workspace** (`sam-ws-<workspace-id>`), not per node. Volumes persist across container rebuilds but are deleted when the workspace is deleted.

2. **Git clone happens inside the container** via `docker exec`, not on the host. This means the container user owns the files from the start.

3. **Use `workspaceMount` in devcontainer config** to override the default bind-mount behavior:
   ```json
   {
     "workspaceMount": "source=sam-ws-${workspaceId},target=/workspaces,type=volume",
     "workspaceFolder": "/workspaces/${repoName}"
   }
   ```
   Or pass equivalent flags to `devcontainer up`.

4. **Eliminate the permission normalization steps** — `ensureWorkspaceWritablePreDevcontainer()` and `ensureWorkspaceWritable()` become unnecessary.

5. **Eliminate the host/container path mapping** — `deriveContainerWorkDir()` and the `/workspace/` vs `/workspaces/` distinction go away.

## Implementation Plan

### Phase 1: Volume Lifecycle Management

#### 1. Volume Creation/Deletion
- Create named Docker volume before `devcontainer up`: `docker volume create sam-ws-<workspace-id>`
- Delete volume when workspace is deleted: `docker volume rm sam-ws-<workspace-id>`
- **Files:** `packages/vm-agent/internal/bootstrap/bootstrap.go`, `packages/vm-agent/internal/server/workspaces.go`

#### 2. Devcontainer Config Override
- Generate a wrapper devcontainer config (or use CLI flags) that sets `workspaceMount` to the named volume
- Research: Does `devcontainer up` support `--mount` or `--workspace-mount` flags? If not, use `--override-config` to inject mount config.
- **Files:** `packages/vm-agent/internal/bootstrap/bootstrap.go`

#### 3. Git Clone Inside Container
- After `devcontainer up` creates the container with the empty volume, clone the repo via `docker exec`:
  ```
  docker exec <container> git clone --branch <branch> --single-branch <url> /workspaces/<repo-name>
  ```
- Git credentials (credential helper) must be installed before clone — reorder bootstrap steps accordingly
- **Files:** `packages/vm-agent/internal/bootstrap/bootstrap.go`

### Phase 2: Bootstrap Flow Refactor

#### 1. New Bootstrap Sequence
```
1. docker volume create sam-ws-<id>          (new)
2. devcontainer up (with volume mount)        (modified — no bind mount)
3. Install git credential helper              (same — docker exec)
4. Configure git identity                     (same — docker exec)
5. git clone inside container                 (moved from host to container)
6. postCreateCommand / lifecycle hooks        (now works — user owns /workspaces/)
7. Mark workspace ready                       (same)
```

**Note:** The devcontainer lifecycle hooks (postCreateCommand etc.) run during step 2, but the repo isn't cloned yet at that point. This means hooks that depend on repo contents (like `npm install`) won't work during the initial `devcontainer up`.

**Possible solutions:**
- **Option A:** Run `devcontainer up` twice — once to build the image + start the container, then clone, then trigger lifecycle hooks manually via `docker exec`
- **Option B:** Use a two-stage approach — `devcontainer up` with `--skip-post-create` (if supported), clone, then run hooks
- **Option C:** Clone into the volume before `devcontainer up` using a temporary container (`docker run --rm -v sam-ws-<id>:/workspaces alpine git clone ...`)
- **Option D:** Clone on host first (current approach), then `docker cp` or `rsync` into the volume before `devcontainer up`

**Option C is recommended** — it's the cleanest separation and matches the Envbuilder pattern. The clone happens in a lightweight throwaway container, then `devcontainer up` runs with the repo already present in the volume, so all lifecycle hooks fire normally.

#### 2. Remove Permission Normalization
- Delete `ensureWorkspaceWritablePreDevcontainer()`
- Delete `ensureWorkspaceWritable()`
- Delete `getContainerUserIDs()`, `getContainerCurrentUserIDs()`
- **Files:** `packages/vm-agent/internal/bootstrap/bootstrap.go`

#### 3. Remove Host/Container Path Mapping
- Delete `deriveContainerWorkDir()` from config
- Simplify `ContainerWorkDir` to always be `/workspaces/<repo-name>`
- Remove `WorkspaceDir` (host path) from config where no longer needed
- **Files:** `packages/vm-agent/internal/config/config.go`

### Phase 3: Workspace Recovery & Rebuild

#### 1. Recovery
- On VM reboot, the named volume persists (Docker volumes survive daemon restarts)
- `devcontainer up` with the same volume mount reconnects to existing data
- No need to re-clone — repo is in the volume

#### 2. Rebuild
- Stop and remove the container
- Run `devcontainer up` again with the same volume — repo files are still there
- Lifecycle hooks re-fire (container is new, volume is old)

#### 3. Workspace Deletion
- Stop and remove the container
- `docker volume rm sam-ws-<workspace-id>`
- **Files:** `packages/vm-agent/internal/server/workspaces.go`

### Phase 4: Fallback Behavior Improvement

While refactoring the bootstrap, also fix the overly aggressive fallback:
- If `postCreateCommand` fails but the image built successfully, do NOT discard the container and fall back to a different image
- Instead, keep the container (features are installed), log the hook failure, and report it to the user
- **Files:** `packages/vm-agent/internal/bootstrap/bootstrap.go`

## Testing Strategy

### Unit Tests
- [ ] Volume creation/deletion lifecycle
- [ ] Bootstrap sequence with volume mount
- [ ] Clone-inside-container flow
- [ ] Recovery with existing volume
- [ ] Rebuild with existing volume (container destroyed, volume preserved)
- [ ] Workspace deletion cleans up volume

### Integration Tests
- [ ] Full workspace create with volume-based storage
- [ ] Devcontainer lifecycle hooks fire correctly (postCreateCommand, postStartCommand)
- [ ] Repos with non-root container users work without permission errors
- [ ] Multi-workspace node with separate volumes
- [ ] Workspace recovery after VM agent restart
- [ ] Workspace rebuild preserves repo state in volume

### Manual Testing Checklist
- [ ] Create workspace from repo with `.devcontainer/devcontainer.json` — hooks run
- [ ] Create workspace from repo without devcontainer config — fallback works
- [ ] Verify SAM's own devcontainer config works (Go, Docker-in-Docker, Claude CLI, etc.)
- [ ] PTY session can read/write files in volume-mounted workspace
- [ ] ACP agent can read/write files in volume-mounted workspace
- [ ] Git operations work (status, diff, file viewer)
- [ ] File browser works
- [ ] Workspace restart preserves files
- [ ] Workspace rebuild preserves files, re-runs hooks
- [ ] Workspace delete removes volume

## Security Considerations

- Named volumes are Docker-managed and isolated per container (no host path traversal)
- Volume names are derived from workspace IDs (UUIDs) — no user-controlled path components
- Git credentials are injected via credential helper (same as current), not stored in volume
- Volume cleanup on workspace deletion prevents data leakage between users

## Migration Path

This is a breaking change to the bootstrap flow. Options:

1. **Flag-based rollout:** Add `WORKSPACE_STORAGE_MODE=volume|bind` config, default to `bind` initially, switch to `volume` after validation
2. **New workspaces only:** Apply volume-based storage to newly created workspaces. Existing workspaces continue with bind mounts until recreated.
3. **Big bang:** Switch all workspaces at once (acceptable since SAM is pre-production)

**Option 3 is recommended** given pre-production status.

## Dependencies

- None — can be implemented independently

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Volume data loss on Docker daemon issues | High | Low | Docker volumes are reliable; same risk as container filesystem |
| `devcontainer up` doesn't support custom mount flags | Medium | Medium | Use `--override-config` to inject `workspaceMount` property |
| Lifecycle hooks depend on repo being present at container start | High | High | Use Option C (clone in throwaway container before `devcontainer up`) |
| Performance regression from volume vs bind mount on Linux | Low | Very Low | Docker volumes on Linux are native ext4/xfs — same performance |
| Multi-workspace volume name collisions | Medium | Very Low | UUID-based naming prevents collisions |

## Related Work

- Current permission bug: `post-create.sh` fails with `Permission denied` on `/workspaces/claude-home`
- Immediate workaround (separate from this task): Move `CLAUDE_CONFIG_DIR` inside the bind-mounted workspace dir
- Fallback behavior fix: VM agent discards working containers when hooks fail

## References

- [VS Code: Change the default source code mount](https://code.visualstudio.com/remote/advancedcontainers/change-default-source-mount)
- [VS Code: Improve disk performance (named volumes)](https://code.visualstudio.com/remote/advancedcontainers/improve-performance)
- [Coder Envbuilder — clone into /workspaces volume](https://github.com/coder/envbuilder)
- [Coder 2025 Devcontainer Rework](https://github.com/coder/coder/issues/16491)
- [devcontainers/spec — workspace mount discussion](https://github.com/devcontainers/spec/issues/106)

---

**Next Steps:**
1. Review and approve this task definition
2. Prototype Option C (clone in throwaway container) to validate the approach
3. Move to `tasks/active/` when ready to implement
