# Experiment Track B: R2-Backed Devcontainer Cache Strategies

**Date:** 2026-05-11
**Status:** Research complete — no code changes, no merge

## Executive Summary

Three R2-backed caching strategies were evaluated against SAM's current ghcr.io-based devcontainer image cache. **The recommended path is Strategy 3 (serverless-registry on R2)** because it requires zero changes to the VM agent's existing `docker pull`/`docker push` flow, eliminates the GitHub token dependency for caching, and has zero R2 egress costs.

Strategy 1 (BuildKit S3 cache) is **not feasible** with the current devcontainer CLI. Strategy 2 (docker save/load tarballs) works but is more complex than Strategy 3 for equivalent benefit.

## Current SAM Devcontainer Cache Flow

The existing flow lives in `packages/vm-agent/internal/bootstrap/bootstrap.go` and `packages/vm-agent/internal/cache/cache.go`:

1. **Resolve cache ref** (bootstrap.go:341-357): If `DEVCONTAINER_CACHE_ENABLED=true` and a GitHub token is available, construct `ghcr.io/<owner>/<repo>:devcontainer-cache[-<configName>]`
2. **Docker login** to ghcr.io using GitHub token as password
3. **Pull cache image** (`docker pull <cacheRef>`) — best-effort, failures logged as warnings
4. **Inject cacheFrom** into devcontainer.json override config as `["<image-ref>"]`
5. **`devcontainer up`** builds the container, using cached layers from the pulled image
6. **Async push** on success: find running container → inspect image ID → `docker tag` → `docker push <cacheRef>`

Key config (config.go:142-144):
- `DEVCONTAINER_CACHE_ENABLED` (default: false)
- `DEVCONTAINER_CACHE_REGISTRY` (default: "ghcr.io")

The flow already supports a configurable registry. The only hard dependency on ghcr.io is the authentication (GitHub token via `x-access-token` username).

---

## Strategy 1: BuildKit S3 Cache Backend → R2

### Concept

Use BuildKit's native S3 cache backend (`--cache-to type=s3,...` / `--cache-from type=s3,...`) pointed at R2's S3-compatible endpoint.

### Findings

**NOT FEASIBLE with current devcontainer CLI.**

1. **BuildKit S3 cache requires the `docker-container` buildx driver.** The default `docker` driver does not support `type=s3` cache. SAM VMs use the default Docker driver.
2. **`devcontainer up` passes `cacheFrom` as image references only.** The devcontainer CLI writes `"cacheFrom": ["ghcr.io/..."]` into the config, which maps to `docker build --cache-from <image-ref>`. It does not support structured cache types like `type=s3,bucket=...,endpoint_url=...`.
3. **Even if buildx were used**, you'd need to create a `docker-container` builder on every fresh VM, configure it with R2 credentials at the BuildKit daemon level, and modify `devcontainer up` to use that builder. This is architecturally invasive.

### R2 S3 Compatibility (for reference)

R2's S3-compatible endpoint (`https://<account-id>.r2.cloudflarestorage.com`) does support the S3 APIs BuildKit uses (PutObject, GetObject, multipart upload, ListObjectsV2). The `region=auto` parameter works. So the S3 protocol itself is not a blocker — the toolchain integration is.

### Verdict: REJECT

The devcontainer CLI → Docker build pipeline does not support BuildKit S3 cache. Switching to buildx would mean abandoning `devcontainer up` or forking the CLI.

---

## Strategy 2: Docker Save/Load Tarball Cache on R2

### Concept

After a successful build, `docker save <image> | gzip` and upload the tarball to R2 via presigned URL. On next build, download from R2, `docker load`, and inject as `cacheFrom`.

### Findings

**Feasible but more complex than Strategy 3 for equivalent benefit.**

| Aspect | Assessment |
|--------|-----------|
| **Download/load speed** | ~1-3 min for a 1GB image (R2 download + gunzip + docker load) |
| **Upload speed** | ~1-2 min for docker save + gzip + multipart upload |
| **Typical image sizes** | 800MB–2GB compressed (Node/Python devcontainers) |
| **R2 multipart** | Works: ≥5MB parts, max 10000 parts, max 5TB total |
| **Existing SAM patterns** | SAM already has presigned URL generation (`apps/api/src/services/attachment-upload.ts`) using `@aws-sdk/client-s3` |

### Implementation sketch

```
VM Agent flow:
1. GET /api/devcontainer-cache/download-url?repo=...&config=...
   → API returns presigned S3 GET URL (30-min TTL)
2. curl <presigned-url> -o /tmp/cache.tar.gz
   → If 404 or error: skip, build from scratch
3. docker load < /tmp/cache.tar.gz
   → Extract loaded image name
4. Inject image name as cacheFrom
5. devcontainer up (uses cached layers)
6. On success (async):
   - docker save <image> | gzip > /tmp/cache.tar.gz
   - GET /api/devcontainer-cache/upload-url?repo=...&config=...
   - curl -X PUT <presigned-url> --upload-file /tmp/cache.tar.gz
```

### Advantages over ghcr.io

- No GitHub token needed for cache (presigned URLs handle auth)
- R2 has zero egress fees
- Presigned URL pattern already exists in SAM

### Disadvantages vs Strategy 3

- Tarballs have **no layer deduplication** — every save creates a full monolithic archive
- Docker save/load is slower than registry pull/push for large images (no parallel layer transfer)
- Requires new API endpoints for presigned URL generation
- Requires new VM agent code (curl download, docker load, docker save, upload)
- **More complex than just changing the registry URL** (Strategy 3)

### Verdict: VIABLE BUT NOT RECOMMENDED

Works, but Strategy 3 achieves the same benefits (no GitHub token, R2 storage, zero egress) with less code change.

---

## Strategy 3: Cloudflare Serverless-Registry (Workers + R2)

### Concept

Deploy [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry) as a Worker backed by R2. VM agents use it as a standard Docker registry — the existing `docker pull`/`docker push` flow works unchanged.

### Findings

**RECOMMENDED. Minimal code changes, maximum benefit.**

| Aspect | Assessment |
|--------|-----------|
| **Project maturity** | Actively maintained (last commit Feb 2026), TypeScript Worker |
| **OCI compliance** | Full Docker Registry HTTP API V2 — manifests, blobs, chunked uploads |
| **Docker CLI compatible** | Yes: `docker login`, `docker pull`, `docker push` all work |
| **Auth model** | Basic auth (username/password) or JWT public key validation |
| **Multi-arch** | Supports manifest lists (not needed now, nice to have) |
| **Layer size limit** | 500MB per layer on standard Worker plan (configurable) |
| **R2 storage cost** | ~$0.015/GB/month. 50GB of cache images = ~$0.75/month |
| **R2 egress** | Free within Cloudflare network |

### Why it fits SAM perfectly

1. **Zero VM agent code changes.** The existing flow already supports `DEVCONTAINER_CACHE_REGISTRY`. Just change the value from `ghcr.io` to `registry.sammy.party` (or whatever subdomain).

2. **Zero devcontainer CLI changes.** `cacheFrom` continues to be an image reference. `docker pull`/`docker push` works against any OCI registry.

3. **Auth simplification.** Instead of GitHub token auth (`x-access-token` + PAT), use a static registry credential (Basic auth). The only change in cache.go is the username/password source.

4. **Self-hoster friendly.** Self-hosters can deploy their own serverless-registry instance, or keep using ghcr.io/Docker Hub — the config is already a simple env var.

5. **Existing infrastructure.** Uses SAM's existing Cloudflare account + R2. No new external dependencies.

### Implementation plan

**Phase 1: Deploy serverless-registry (infrastructure)**

```bash
# Clone and deploy
git clone https://github.com/cloudflare/serverless-registry
cd serverless-registry

# Configure wrangler.toml with SAM's R2 bucket binding
# Deploy to registry.sammy.party (staging) / registry.simple-agent-manager.org (prod)
wrangler deploy

# Set auth credentials
wrangler secret put REGISTRY_USERNAME
wrangler secret put REGISTRY_PASSWORD
```

Add to SAM's Pulumi stack:
- DNS record: `registry.sammy.party` → Worker route
- R2 bucket: `sam-registry` (or reuse `sam-staging-assets` with a prefix)

**Phase 2: VM agent config changes (minimal)**

```go
// config.go — add new env vars for registry auth
DevcontainerCacheRegistryUser string // env: DEVCONTAINER_CACHE_REGISTRY_USER
DevcontainerCacheRegistryPass string // env: DEVCONTAINER_CACHE_REGISTRY_PASS
```

```go
// cache.go — modify DockerLogin to use configurable credentials
// Currently hardcodes "x-access-token" username for ghcr.io
func DockerLogin(ctx context.Context, registry, username, token string) error {
    // Already generic — just needs correct username/password passed in
}
```

```go
// bootstrap.go — change login call from GitHub-token-based to config-based
if loginErr := cache.DockerLogin(ctx, cfg.DevcontainerCacheRegistry,
    cfg.DevcontainerCacheRegistryUser, cfg.DevcontainerCacheRegistryPass); loginErr != nil {
    // ...
}
```

**Phase 3: Cloud-init template updates**

Pass registry credentials via cloud-init env vars:
```yaml
DEVCONTAINER_CACHE_ENABLED: "true"
DEVCONTAINER_CACHE_REGISTRY: "registry.sammy.party"
DEVCONTAINER_CACHE_REGISTRY_USER: "<from Worker secrets>"
DEVCONTAINER_CACHE_REGISTRY_PASS: "<from Worker secrets>"
```

### Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Registry Worker downtime | LOW | Cache is best-effort. If registry is down, VMs build from scratch (existing behavior). |
| 500MB layer limit | LOW | Most devcontainer layers are <500MB. Can be configured. |
| Credential rotation | LOW | Static Basic auth credentials, rotated via `wrangler secret put`. |
| Another Worker to maintain | LOW | Upstream is actively maintained. SAM just deploys it. |

---

## Comparison Matrix

| | BuildKit S3 | Docker Save/Load | Serverless Registry |
|---|---|---|---|
| **Feasibility** | NOT feasible | Feasible | Feasible |
| **VM agent changes** | N/A | Major (new download/upload code) | Minor (configurable auth) |
| **Devcontainer CLI changes** | Would require fork | None | None |
| **GitHub token required** | N/A | No | No |
| **Layer deduplication** | Yes (BuildKit) | No (monolithic tarball) | Yes (OCI layers) |
| **Parallel layer transfer** | Yes | No | Yes |
| **R2 egress cost** | $0 | $0 | $0 |
| **Self-hoster friendly** | N/A | Moderate | Excellent |
| **Implementation effort** | Impossible | ~3-5 days | ~2-3 days |
| **Operational burden** | N/A | Low | Low |

---

## Recommended Implementation Path

**Strategy 3 (Serverless Registry on R2)** with backward-compatible ghcr.io support.

### Step-by-step

1. **Deploy serverless-registry Worker** on `registry.sammy.party` with R2 binding
2. **Add registry credentials** to Worker secrets and cloud-init template
3. **Modify `config.go`** to add `DEVCONTAINER_CACHE_REGISTRY_USER` and `DEVCONTAINER_CACHE_REGISTRY_PASS` env vars
4. **Modify `bootstrap.go`** to use config-based credentials instead of hardcoded GitHub token auth
5. **Keep `DEVCONTAINER_CACHE_REGISTRY` default as `ghcr.io`** for backward compatibility
6. **Set staging/prod config** to `registry.sammy.party` / `registry.simple-agent-manager.org`
7. **Test on staging**: create a workspace, verify cache push, destroy node, create another workspace, verify cache hit

### What NOT to do

- Do NOT try to make BuildKit S3 cache work. The devcontainer CLI does not support it.
- Do NOT use docker save/load. It's more complex for the same benefit.
- Do NOT remove ghcr.io support. Keep it as the default for self-hosters who prefer it.

---

## Blockers for End-to-End Testing

This workspace has no Docker, no devcontainer CLI, and no R2 API credentials. Testing requires:

1. **R2 API credentials** (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) for creating the registry bucket
2. **A VM with Docker** to test `docker login`/`pull`/`push` against the registry
3. **Serverless-registry deployed** to a staging subdomain

These are infrastructure prerequisites, not code blockers. The implementation path above can proceed once credentials are available.

---

## Environment Observed

```
Docker:                 not available (lightweight workspace)
devcontainer CLI:       not available
R2 credentials:        not set (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
CF_TOKEN:              available (staging read access)
R2 buckets (staging):  sam-pulumi-state, sam-staging-assets
```
