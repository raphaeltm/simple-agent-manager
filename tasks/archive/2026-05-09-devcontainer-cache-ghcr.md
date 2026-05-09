# Opportunistic Devcontainer Image Caching (GHCR)

## Problem

Devcontainer builds on cold nodes take 2-8 minutes because Docker rebuilds every layer from scratch. Second builds on the same node are fast (~30s) thanks to Docker's local BuildKit cache. But when a project lands on a new node (common with ephemeral VMs and warm pool recycling), the full build penalty is paid again.

## Solution

After every successful `devcontainer up`, push the resulting image to GHCR as a cache. Before every build, try to pull the cached image and use it as a `--cache-from` source. No explicit pre-build step — the cache is populated opportunistically.

Track A (GHCR) approved by user. Uses the GitHub token SAM already has (`bootstrapState.GitHubToken`).

## Research Findings

### Key Files
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — 2930 lines, contains `ensureDevcontainerReady()`, `writeMountOverrideConfig()`, `writeCredentialOverrideConfig()`, `devcontainerUpArgs()`, `findDevcontainerID()`
- `packages/vm-agent/internal/config/config.go` — Config struct, env var loading
- `bootstrapState` struct (line 83): has `GitHubToken` field
- `ProvisionState` struct (line 104): has `GitHubToken`, `Lightweight`, `DevcontainerConfigName`
- `PrepareWorkspace()` (line 288): orchestrates the full bootstrap, calls `ensureDevcontainerReady()`
- `ensureDevcontainerReady()` (line 817): the main build function; needs cache inject/push
- `devcontainerUpArgs()` (line 1030): builds args for `devcontainer up` — no `--cache-from`
- `writeMountOverrideConfig()` (line 1509): writes full override JSON with mergedConfiguration — needs `cacheFrom` injection
- `writeCredentialOverrideConfig()` (line 2180): writes minimal override with mounts/containerEnv — needs `cacheFrom` injection
- `findDevcontainerID()` (line 2215): finds running container by label — used for push

### Architecture Decisions
- `devcontainer up` supports `--cache-from` but the override config approach via `cacheFrom` JSON field is cleaner
- The override config already uses `map[string]interface{}` so adding `cacheFrom` is straightforward
- GitHub token is available via `bootstrapState.GitHubToken` or `ProvisionState.GitHubToken`
- Token needs `packages:write` scope for push — if missing, push fails silently (best-effort)
- Cache ref format: `ghcr.io/<owner>/<repo>:devcontainer-cache` or `:devcontainer-cache-<configName>`

### Edge Cases
- First build: pull fails silently, build as normal, push creates cache
- Lightweight mode: skip caching entirely
- Fallback to default image: don't cache
- Non-GitHub repos: cache disabled (no GHCR token)
- Multiple devcontainer configs: separate tag per config name
- Concurrent builds same project: last push wins

## Implementation Checklist

### 1. Add config fields
- [x] Add `DevcontainerCacheEnabled` (env: `DEVCONTAINER_CACHE_ENABLED`, default: `false`)
- [x] Add `DevcontainerCacheRegistry` (env: `DEVCONTAINER_CACHE_REGISTRY`, default: `ghcr.io`)

### 2. Create `internal/cache/` package
- [x] `ParseGitHubRepo(repoURL string) (owner, repo string, ok bool)` — extract owner/repo from git URL
- [x] `CacheRef(registry, owner, repo, configName string) string` — construct cache image reference
- [x] `DockerLogin(ctx, registry, username, token string) error` — `docker login` to registry
- [x] `PullCacheImage(ctx, ref string) error` — `docker pull <ref>`, returns error
- [x] `PushCacheImage(ctx, containerLabelKey, containerLabelValue, cacheRef string) error` — find image from container, tag, push

### 3. Write tests for cache package
- [x] Test ParseGitHubRepo with various URL formats (https, ssh, owner/repo)
- [x] Test CacheRef construction including named configs
- [x] Test edge cases (non-GitHub repos, empty inputs)

### 4. Integrate into bootstrap flow
- [x] Modify `ensureDevcontainerReady()`: before build, call login+pull (best-effort)
- [x] Inject `cacheFrom` into override configs (`writeMountOverrideConfig`, `writeCredentialOverrideConfig`)
- [x] After successful build (non-fallback): launch async push in background goroutine
- [x] Pass GitHub token through from `PrepareWorkspace` to `ensureDevcontainerReady`
- [x] Add boot log entries for cache status ("Cache hit", "No cache found", "Cache push started")
- [x] Skip caching in lightweight mode and fallback mode

### 5. Documentation
- [x] Document `packages:write` permission requirement for GitHub App (see PR description)
- [x] Add env vars to relevant docs (see PR description)

## Acceptance Criteria

- [x] `DEVCONTAINER_CACHE_ENABLED=true` activates caching
- [x] Before build: docker login + pull attempt (best-effort, logged)
- [x] `cacheFrom` injected into devcontainer override config
- [x] After successful build: async push in background goroutine
- [x] Lightweight mode skips caching
- [x] Fallback to default image skips caching
- [x] Non-GitHub repos skip caching (no GHCR token)
- [x] Named configs use separate cache tags
- [x] All failures are non-fatal (logged as warnings, never block workspace creation)
- [x] Boot logs surface cache status
- [x] Unit tests cover ParseGitHubRepo, CacheRef, and edge cases

## References

- Idea: 01KR37DCW4FXDRRPWNMW5MM472
- Task: 01KR5MME1M220GXBKVYN0RY70M
