# Registry Proxy Spike (Workers v2 Registry Proxy)

**Status**: Active (spike — draft PR, do not merge without human review)
**Branch**: `sam/registry-proxy-spike-01ktsb`
**Related**: App deployment system research — library `/research/app-deployment/` (esp. `02-phased-delivery-plan`, `07-security-policy-and-secrets`)
**Parent conversation task**: `01KTSBMA69G1MWC5ZJZBEWJ413`

## Goal

Prove that a Cloudflare Worker can front the Cloudflare managed container registry
(`registry.cloudflare.com` — the same registry SAM uses for the devcontainer build
cache) speaking the docker registry v2 protocol, so that:

- Agents in workspaces authenticate with **project-scoped SAM tokens** instead of
  ever seeing the upstream CF registry credential
- Every request is clamped to the project's repository namespace (`proj-{id}/...`)
- The upstream credential is swapped in server-side (minted via the
  `devcontainer-cache.ts` pattern in production; static env var in the spike)

## Assumptions To Test

- [x] Standard docker token-auth flow (401 challenge → /token → Bearer retry) can be
      implemented in a Worker with no external deps (HS256 via WebCrypto) — unit tested
- [x] v2 URL paths with slash-containing repository names can be parsed reliably —
      unit tested (`parseV2Path` locates the last known resource segment)
- [x] Blob-upload `Location` headers can be rewritten to keep upload sessions behind
      the proxy while passing through signed storage redirect URLs — unit tested
- [x] Streaming request bodies can be forwarded (requires `duplex: 'half'` — found by
      test failure, see Findings)
- [ ] Real `docker push` / `docker pull` works end-to-end through `wrangler dev`
      against a local `registry:2` upstream (in progress)
- [ ] Prefix enforcement rejects a second project's token pushing to the first
      project's namespace, via real docker CLI
- [ ] NOT locally testable: Workers edge request-body size limit vs monolithic layer
      PATCH uploads (100MB free/pro, 200MB business, 500MB enterprise). Must be
      validated on a deployed Worker later. Documented in library.

## Implementation Checklist

- [x] Scaffold `apps/registry-proxy/` (package.json, tsconfig, wrangler.toml, vitest)
- [x] `src/jwt.ts` — HS256 sign/verify with docker-token-spec `access` claims
- [x] `src/scope.ts` — scope grammar + /v2 path parsing + namespace helpers
- [x] `src/upstream.ts` — credential swap, hop-header strip, Location rewriting
- [x] `src/index.ts` — /token issuance (namespace clamping) + /v2/* enforcement
      (defense-in-depth namespace check from verified claims) + proxying
- [x] Unit + vertical-slice tests (46 passing)
- [ ] Local docker push/pull experiment via wrangler dev + registry:2
- [ ] Record findings in library (`/research/app-deployment/11-experiment-log.md`)

## Findings

- **`duplex: 'half'` required**: forwarding a streaming request body via
  `new Request(url, { body: request.body })` throws
  `TypeError: RequestInit: duplex option is required when sending a body` in
  Node/undici (and is required by the fetch spec). Fixed in
  `src/upstream.ts:buildUpstreamRequest()`; caught by a unit test before any
  manual experiment.

## Production Notes (Out of Spike Scope)

- Replace `DEV_PROJECT_TOKENS` env map with SAM API/D1 validation + the
  environment-level "agents may deploy here" gate
- Mint upstream credentials via `apps/api/src/services/devcontainer-cache.ts`
  pattern (`mintCloudflareRegistryCredentials`), cached until expiry
- Add the worker to `scripts/deploy/sync-wrangler-config.ts` + deployment pipeline
- Rate limiting on /token; audit logging of pushes (release provenance)
