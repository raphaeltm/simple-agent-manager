# 11 — Experiment Log

> Running log of experiments and spikes validating assumptions from the
> app-deployment research docs. Each entry records what was tested, how, the
> result, and what remains unproven. Code references point at the spike branch
> `sam/registry-proxy-spike-01ktsb` (draft PR #1280).

Last updated: 2026-06-11

## Experiment 1: Workers registry proxy with project-scoped tokens

**Question** (from `02-phased-delivery-plan.md` / `07-security-policy-and-secrets.md`):
Can a Cloudflare Worker front the Cloudflare managed container registry
(`registry.cloudflare.com`, the same registry SAM already uses for the
devcontainer build cache) speaking the docker registry v2 protocol, such that
agents authenticate with project-scoped SAM tokens, every request is clamped to
`proj-{projectId}/...`, and the upstream credential never leaves SAM?

**Status**: VALIDATED locally (real docker CLI end-to-end). One assumption
remains untestable locally (see "Not yet proven").

### Setup

- `apps/registry-proxy/` Worker (Hono, zero non-Hono deps; HS256 JWT via
  WebCrypto) on branch `sam/registry-proxy-spike-01ktsb`, draft PR #1280
- Upstream: local `registry:2` Docker container on `:5000` (stand-in for
  `registry.cloudflare.com`; the v2 protocol surface is identical)
- Proxy: `wrangler dev` on `:8787`, `.dev.vars` providing `TOKEN_SIGNING_SECRET`
  and a spike-only `DEV_PROJECT_TOKENS` map (`samToken -> projectId`); production
  validates tokens against the SAM API and the environment "agents may deploy
  here" gate instead
- Client: real `docker` CLI (29.5.3). Docker treats `localhost` registries as
  insecure-allowed by default, so no TLS needed for the local loop

### Results (all with the real docker CLI, 2026-06-10)

| Check | Result |
|-------|--------|
| `docker login localhost:8787` with project-A SAM token | Login Succeeded (full token-auth flow: /v2/ 401 challenge -> GET /token Basic auth -> Bearer JWT retry) |
| `docker push localhost:8787/proj-projecta/hello:1` (busybox) | Pushed: blobs + manifest, digest returned |
| `docker pull` of the same image after local removal | Downloaded through the proxy |
| Push to `proj-projectb/...` with project-A credentials | **403 Forbidden** on first blob HEAD |
| Push to `outside-namespace/...` (no proj- prefix) | **403 Forbidden** |
| Pull of `proj-projecta/hello` while logged in as project-B | **403 Forbidden** on manifest HEAD |
| `docker login` with an unknown token | Rejected (401 unauthorized) |
| `/v2/_catalog` through the proxy | Denied (403; upstream catalog confirmed reachable directly, so the proxy is what blocks it) |

Unit/vertical-slice suite: 57 tests passing (scope grammar, v2 path parsing with
slash-containing repo names, JWT roundtrip/expiry/tamper, namespace clamping at
issuance, defense-in-depth enforcement from verified `claims.sub`, Location
rewriting, upstream credential swap, WWW-Authenticate stripping, plus the
security-hardening tests below).

### Specialist review outcome (2026-06-11)

security-auditor: conditional pass (0 CRITICAL, 3 HIGH). cloudflare-specialist:
pass for spike scope. All HIGHs fixed in-branch (commit 5e359247):

1. **JWT header `alg` validated as HS256** before signature verification --
   algorithm-confusion forgeries (`none`, `RS256`, missing alg) now rejected
   and tested.
2. **`iss`/`aud` verified** against the expected issuer/audience on every
   data-path verification.
3. **Project IDs lowercase-normalized once at issuance** so `claims.sub` and
   the repository namespace can never disagree on case.
4. **HMAC CryptoKey cached per secret** (CF reviewer HIGH -- avoids importKey
   per request).

Also hardened: colon-less Basic auth rejected, token TTL bounded (default
1800s, max 3600s, zero/invalid falls back), `console.error` on malformed dev
token map, DELETE->push mapping + WHATWG path-normalization assumption
documented, dot-segment traversal and `%2f` encoding tests added. Remaining
production-gated reviewer items (vitest-pool-workers migration, real
`registry.cloudflare.com` redirect behavior, request-body cap) are in the
"Not yet proven" / production-deltas lists.

### Findings / gotchas

1. **`duplex: 'half'` is required when forwarding streaming request bodies.**
   `new Request(url, { body: incoming.body })` throws
   `TypeError: RequestInit: duplex option is required when sending a body`
   (fetch spec; enforced by Node/undici and relevant to Workers). Caught by a
   unit test before any manual run. Fixed in `upstream.ts:buildUpstreamRequest()`.
2. **Blob-upload `Location` rewriting works as designed.** `registry:2` returns
   relative Locations (kept as-is); absolute Locations pointing at the upstream
   host are re-rooted at the proxy origin; foreign absolute URLs (signed R2-style
   blob redirects) pass through untouched. All three branches covered by tests;
   docker's multi-request upload session (POST -> PATCH -> PUT) completed through
   the proxy.
3. **Repository names contain slashes**, so `/v2/<name>/manifests|blobs|tags|referrers/...`
   must be parsed by locating the **last** known resource segment, not by
   position. A repo literally named `proj-a/blobs` parses correctly.
4. **Docker sends multiple `scope` params** in one /token request. The proxy
   grants the intersection per scope; out-of-namespace repos get an empty action
   list (standard registry behavior -- the client then gets 403 at the data path,
   which is exactly what we observed).
5. **Defense in depth matters**: enforcement happens twice -- at token issuance
   (clamping) and on every /v2 request from the *verified* `claims.sub`,
   independent of the access list. A forged-access-list token is still rejected
   (unit tested).

### Not yet proven (requires deployed Worker)

- **Workers edge request-body size limit vs monolithic layer uploads.** Docker
  uploads each layer as a single PATCH; Cloudflare caps request bodies at
  100MB (free/pro), 200MB (business), 500MB (enterprise). Cannot be tested in
  `wrangler dev` (no edge limit locally). Mitigations if it bites: chunked
  upload negotiation, size policy on images, or enterprise plan. This is the
  #1 thing to validate when the spike deploys to staging.
- Real `registry.cloudflare.com` behavior: credential minting via the
  `devcontainer-cache.ts` pattern, its redirect behavior on blob GETs (signed
  URLs), and any deviations from `registry:2` semantics.
- Latency/throughput of large pushes through the proxy at the edge.

### Production deltas (out of spike scope, tracked in PR #1280 / task file)

- `DEV_PROJECT_TOKENS` env map -> SAM API/D1 token validation + environment-level
  agent-access gate
- Static upstream Basic credential -> minted short-lived CF registry credentials
  (`apps/api/src/services/devcontainer-cache.ts:mintCloudflareRegistryCredentials`),
  cached until expiry
- Wire into `scripts/deploy/sync-wrangler-config.ts` + deploy pipeline
- Rate limiting on /token; push audit logging for release provenance

## Experiment 2: Deployment manifest schema (COMPLETE -- draft PR #1281)

Task `01KTSXC6FY0K6211VFBYB0MT3B`, branch
`sam/build-deployment-manifest-schema-01ktsx`, draft PR #1281 (open, unmerged,
awaiting human review).

**What shipped**: `packages/shared/src/deployment-manifest/` -- normalized
manifest schema v1 (per doc 06) + validation module, exported from the shared
package index. Zod with `.strict()` on every object schema = default-deny
unknown fields at every nesting level.

**Rules enforced and adversarially tested (54 unit tests):**

- Digest-pinned images only (sha256 required; mutable tags, wrong prefix,
  short/uppercase hex all rejected)
- Secrets by reference only (`{ secret: "name" }` or plain string; inline
  secret-looking values and extra fields rejected)
- Named volumes only (host paths / bind mounts rejected by volume-name regex)
- Cross-reference validation: route.service, service volume.name, hook.service
  must all reference declared entities
- Friendly explicit errors for 8+ dangerous Compose-isms (`build`,
  `privileged`, `network_mode`, `ports`, `devices`, `cap_add/drop`,
  `security_opt`, `sysctls`, `ulimits`, `pid`, `ipc`, `extends`, `env_file`,
  `runtime`)
- Structured `{ path, message }` error format ready for MCP tool responses

## Experiment 3: node_role groundwork (COMPLETE -- draft PR #1282)

Task `01KTSXCYQ9T0KZJQXV4FT3X3ZS`, branch `sam/add-noderole-nodes-data-01ktsx`,
draft PR #1282 (open, unmerged, awaiting human review).

**What shipped**: additive migration 0066
(`ALTER TABLE nodes ADD COLUMN node_role TEXT NOT NULL DEFAULT 'workspace'`),
`NodeRole` ('workspace' | 'deployment') threaded through Drizzle schema, shared
types, and node API responses (`toNodeResponse`).

**Lifecycle audit result**: 11 query sites assumed all nodes are workspace
nodes and were filtered to exempt deployment nodes -- node-selector (scheduler
can never place workspaces/tasks on a deployment node), node-cleanup cron sweep
(4 queries), task-runner node-steps (3 queries), nodes routes quota,
workspaces/crud quota. This confirmed the doc 03 prediction that the reaper /
warm-pool / max-lifetime machinery treats every node as ephemeral and needed a
role gate (rule 40 bug class: counting/selecting rows without a discriminator).

**Tests**: 13 new vertical-slice tests seeding both a workspace node and a
deployment node; deployment node is NOT reaped, NOT warm-pool transitioned,
NOT max-lifetime expired, NOT scheduler-selected, while the workspace node is
handled normally. All 5123 existing tests pass.

**Out of scope (next slices)**: node creation with role 'deployment' (no UI
yet), deployment agent / vm-agent changes, cloud-init, environments tables.

## Experiment 4: Caddy ACME spike (VALIDATED -- 2026-06-11)

Task `01KTWD1A9J1JHQEXHXB3MNPE4T`, branch `sam/spike-node-side-caddy-01ktwd`.
Full findings in `13-caddy-acme-spike-findings.md`.

**Question** (from Q4/Q6/Q14 in `09-open-questions.md`): Can Caddy serve as the
node data-plane proxy with built-in ACME for automatic TLS, zero-downtime config
changes, and full independence from the vm-agent process?

**Status**: VALIDATED for proxy behavior, admin API, zero-downtime config,
process independence. ACME issuance not tested live (CF_TOKEN lacks DNS write
permission -- documented as a prerequisite for production).

### Key results

| Check | Result |
|-------|--------|
| Reverse proxy via admin API | Instant route addition, immediate traffic flow |
| Zero-downtime route add/remove (host-matched) | 277 requests, **0 errors** (0.0%) |
| Proxy independence: kill -9 "agent" during traffic | 229 requests, **0 errors** (0.0%) |
| Backend restart recovery | Automatic -- Caddy returns 502 during downtime, recovers instantly |
| CF_TOKEN DNS write capability | **NO** -- authentication error on POST to dns_records |

### Decisions recommended

- **Q14 (proxy):** Caddy -- zero-downtime admin API, built-in ACME, single binary
- **Q4 (edge-to-node):** Option 3 -- node-side ACME with grey-cloud DNS; DNS-01
  for SAM-domain hostnames (zero issuance gap), HTTP-01 for custom domains
- **Q6 (hostname):** Multi-level `{env}.{project}.apps.{BASE_DOMAIN}` -- enabled
  by per-hostname certs lifting the wildcard constraint

### Not yet proven

- Live ACME cert issuance (requires CF_DNS_API_TOKEN with Zone.DNS:Edit)
- Custom Caddy build with caddy-dns/cloudflare module on a real node
- Cert persistence across node reboots
- On-demand TLS for custom domains
