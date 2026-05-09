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
- [ ] Add `DevcontainerCacheEnabled` (env: `DEVCONTAINER_CACHE_ENABLED`, default: `false`)
- [ ] Add `DevcontainerCacheRegistry` (env: `DEVCONTAINER_CACHE_REGISTRY`, default: `ghcr.io`)

### 2. Create `internal/cache/` package
- [ ] `ParseGitHubRepo(repoURL string) (owner, repo string, ok bool)` — extract owner/repo from git URL
- [ ] `CacheRef(registry, owner, repo, configName string) string` — construct cache image reference
- [ ] `DockerLogin(ctx, registry, username, token string) error` — `docker login` to registry
- [ ] `PullCacheImage(ctx, ref string) error` — `docker pull <ref>`, returns error
- [ ] `PushCacheImage(ctx, containerLabelKey, containerLabelValue, cacheRef string) error` — find image from container, tag, push

### 3. Write tests for cache package
- [ ] Test ParseGitHubRepo with various URL formats (https, ssh, owner/repo)
- [ ] Test CacheRef construction including named configs
- [ ] Test edge cases (non-GitHub repos, empty inputs)

### 4. Integrate into bootstrap flow
- [ ] Modify `ensureDevcontainerReady()`: before build, call login+pull (best-effort)
- [ ] Inject `cacheFrom` into override configs (`writeMountOverrideConfig`, `writeCredentialOverrideConfig`)
- [ ] After successful build (non-fallback): launch async push in background goroutine
- [ ] Pass GitHub token through from `PrepareWorkspace` to `ensureDevcontainerReady`
- [ ] Add boot log entries for cache status ("Cache hit", "No cache found", "Cache push started")
- [ ] Skip caching in lightweight mode and fallback mode

### 5. Documentation
- [ ] Document `packages:write` permission requirement for GitHub App
- [ ] Add env vars to relevant docs

## Acceptance Criteria

- [ ] `DEVCONTAINER_CACHE_ENABLED=true` activates caching
- [ ] Before build: docker login + pull attempt (best-effort, logged)
- [ ] `cacheFrom` injected into devcontainer override config
- [ ] After successful build: async push in background goroutine
- [ ] Lightweight mode skips caching
- [ ] Fallback to default image skips caching
- [ ] Non-GitHub repos skip caching (no GHCR token)
- [ ] Named configs use separate cache tags
- [ ] All failures are non-fatal (logged as warnings, never block workspace creation)
- [ ] Boot logs surface cache status
- [ ] Unit tests cover ParseGitHubRepo, CacheRef, and edge cases

## References

- Idea: 01KR37DCW4FXDRRPWNMW5MM472
- Task: 01KR5MME1M220GXBKVYN0RY70M
