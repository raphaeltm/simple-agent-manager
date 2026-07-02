# Additional Cloud Provider Implementations

**Created**: 2026-02-16 (consolidated 2026-07-02 from seven per-provider task files)
**Status**: Backlog
**Priority**: Medium (OVH: Low)
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`

## Context

Umbrella task for implementing additional cloud providers beyond Hetzner and Scaleway. Each provider below was researched on 2026-02-16; the per-provider API research is preserved in the sections that follow. Implement providers one at a time — each is a self-contained unit of work following the same pattern.

**Type changes**: Each provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing (exception: UpCloud's types already exist after the infrastructure task).

## Common Implementation Checklist (per provider)

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts` (if not pre-defined)
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts` (if not pre-defined)
- [ ] Create `packages/providers/src/<provider>.ts` implementing the `Provider` interface: `createVM()`, `deleteVM()` (idempotent), `getVM()`, `listVMs()` (tag/label filtered), `powerOff()`, `powerOn()`, `validateToken()`
- [ ] Map provider status values to `VMInstance` status
- [ ] Define size mappings and location list (verify slugs/IDs at implementation time)
- [ ] Reuse provider contract test suite from the infrastructure task
- [ ] Unit tests with mocked fetch, >90% coverage

Reference implementation: `packages/providers/src/hetzner.ts`.

---

## DigitalOcean (Effort: Medium)

Simplest port — Bearer token, clean REST, closest to Hetzner. Good first candidate.

- **Auth**: `Authorization: Bearer <token>`, base `https://api.digitalocean.com/v2`. Validate via `GET /account`.
- **Lifecycle**: `POST/GET/DELETE /droplets`, actions via `POST /droplets/{id}/actions` (`power_off`, `power_on`, `shutdown`). List filter `?tag_name={tag}` (one tag only — multi-tag filter client-side).
- **Cloud-init**: `user_data` plain text, 64KB limit.
- **Quirks**: IP NOT in create response — poll `GET /droplets/{id}` until `active` + `networks.v4` populated. Status values only `new/active/off/archive`. Use graceful `shutdown` with `power_off` fallback after timeout. Tags are plain strings (may need `POST /tags` pre-creation — verify).
- **Sizes**: small `s-2vcpu-4gb`, medium `s-4vcpu-8gb`, large `s-8vcpu-16gb-amd` (verify per-region availability). Regions: `nyc1/nyc3/sfo3/ams3/fra1/lon1/sgp1/blr1/tor1/syd1`.

## Vultr (Effort: Medium)

DO-like REST API with base64 user data and a triple status model.

- **Auth**: `Authorization: Bearer <api_key>`, base `https://api.vultr.com/v2`. Validate via `GET /account`.
- **Lifecycle**: `POST/GET/DELETE /instances`, `POST /instances/{id}/halt|start|reboot`. List filter `?tag={tag}` (one at a time).
- **Cloud-init**: `user_data` MUST be base64-encoded (limit undocumented — test).
- **Quirks**: THREE status fields (`status`, `power_status`, `server_status`) must be combined. `main_ip` is `0.0.0.0` initially — poll. No graceful shutdown (halt only). OS IDs are mutable integers — resolve dynamically via `GET /os`. Verify delete idempotency (204 vs 404).
- **Sizes**: small `vc2-2c-4gb`, medium `vc2-4c-8gb`, large `vhp-8c-16gb-amd` (no `vc2-8c-16gb`; verify via `GET /plans`). Regions: `ewr/ord/lax/ams/fra/lhr/nrt/sgp/syd`.

## Linode / Akamai (Effort: Medium)

Straightforward REST; unique `X-Filter` header filtering and required `root_pass`.

- **Auth**: `Authorization: Bearer <token>`, base `https://api.linode.com/v4`. Validate via `GET /profile`.
- **Lifecycle**: `POST/GET/DELETE /linode/instances`, `POST /linode/instances/{id}/shutdown|boot`.
- **Cloud-init**: nested `metadata.user_data`, base64-encoded.
- **Quirks**: `root_pass` REQUIRED when creating from image — generate cryptographically random, never stored. Public IP available immediately in create response (`ipv4[0]`) — no polling. Tag filtering via `X-Filter: {"tags": {"$contains": "sam-managed"}}` JSON header. Rate limit 800 req/min (429 + `Retry-After`).
- **Sizes**: small `g6-standard-2`, medium `g6-standard-4`, large `g6-standard-8` (verify via `GET /linode/types`). Regions: `us-east/us-central/us-west/eu-west/eu-central/ap-south/ap-northeast/ap-southeast`.

## UpCloud (Effort: Medium)

First HTTP Basic auth provider (username + password credential fields).

- **Auth**: `Authorization: Basic <base64(username:password)>`, base `https://api.upcloud.com/1.3`. Validate via `GET /account`. Types (`{ provider: 'upcloud'; username; password }`) already exist after infrastructure task.
- **Lifecycle**: `POST/GET /server`, `DELETE /server/{uuid}?storages=1` (delete attached storage too), `POST /server/{uuid}/stop` (`{"stop_server":{"stop_type":"soft"}}`), `POST /server/{uuid}/start`.
- **Cloud-init**: `user_data` placement (server vs storage-template level) needs verification at implementation time.
- **Quirks**: OS templates are UUIDs (query `GET /storage/template` — they change). Plans are names like `2xCPU-4GB` (query `GET /plan`). Storage devices defined explicitly at create. Responses are nested/wrapped (`{"server": {...}}`). Tags use nested structure and may need pre-creation (`POST /tag`); list by tag via `GET /server/tag/{tag}`. Per-server firewall may need port openings.
- **Sizes**: small `2xCPU-4GB`, medium `4xCPU-8GB`, large `8xCPU-16GB`. Zones: `de-fra1/fi-hel1/fi-hel2/nl-ams1/us-chi1/us-nyc1/us-sjo1/sg-sin1/au-syd1/uk-lon1`.

## GCP Compute Engine (Effort: Large)

Complex: OAuth2 via service-account JWT (WebCrypto RSA-SHA256), async operations, verbose payloads.

- **Auth**: Parse service account JSON (`client_email`, `private_key`); build JWT (`scope: https://www.googleapis.com/auth/compute`, `aud: https://oauth2.googleapis.com/token`, 1h expiry); sign with `crypto.subtle.sign("RSASSA-PKCS1-v1_5", ...)` (PEM → PKCS8 import); exchange at `POST https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`). Cache token (1h) and refresh. Credential fields: `serviceAccountJson`, `projectId`, `zone`. Base `https://compute.googleapis.com/compute/v1/projects/{project}`.
- **Lifecycle**: `POST/GET/DELETE /zones/{zone}/instances[/{name}]`, `POST .../{name}/stop|start`. List filter `?filter=labels.sam-managed=true`.
- **Cloud-init**: metadata item `{key: "user-data", value: ...}` plain text (256KB/value, 512KB total).
- **Quirks**: ALL mutations return an `Operation` — poll `GET /zones/{zone}/operations/{op}` until `DONE`. Verbose create payload: full-URL `machineType`, boot disk with `initializeParams.sourceImage` (e.g. `projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64`), network interface needs `accessConfigs: [{"type": "ONE_TO_ONE_NAT"}]` for a public IP. Instances addressed by name (unique per zone). Labels: lowercase kv, ≤63 chars.
- **Sizes**: small `e2-standard-2` (2/8GB — GCP min), medium `e2-standard-4`, large `e2-standard-8` (more RAM/vCPU than other providers; custom machine types possible). Zones: `us-central1-a/us-east1-b/us-west1-a/europe-west1-b/europe-west3-a/europe-west2-a/asia-southeast1-a/asia-northeast1-a/australia-southeast1-a`.
- **Extra checklist**: JWT signing tests against known outputs, token-cache tests, operation-polling tests (cycles, timeout, failure).

## AWS Lightsail (Effort: Large)

SigV4 signing from scratch (WebCrypto), JSON-RPC style, static IP lifecycle.

- **Auth**: AWS SigV4 (HMAC-SHA256 chain via `crypto.subtle`): canonical request → string-to-sign → derived key `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), "lightsail"), "aws4_request")` → `Authorization` header. Credential fields: `accessKeyId`, `secretAccessKey`, `region`. Endpoint `https://lightsail.{region}.amazonaws.com/`, JSON-RPC over `POST /` with `X-Amz-Target: Lightsail_20161128.<Action>`, content type `application/x-amz-json-1.1`. Validate via `GetRegions`/`GetInstances`.
- **Lifecycle actions**: `CreateInstances`, `GetInstance(s)`, `DeleteInstance`, `StopInstance`, `StartInstance`, plus static IP: `AllocateStaticIp`/`AttachStaticIp`/`DetachStaticIp`/`ReleaseStaticIp`.
- **Cloud-init**: `userData` plain text, **16KB limit** — tightest of all providers; verify our cloud-init fits.
- **Quirks**: Public IP CHANGES on stop/start — must allocate + attach a static IP for stable DNS (detach + release on delete; unattached static IPs cost money). Instances addressed by name (unique per region). NO tag-based list filtering — fetch all + filter client-side with `pageToken` pagination. Images via blueprint IDs (`ubuntu_24_04`); sizes via bundle IDs.
- **Sizes**: small `medium_3_0` (2/4GB), medium `xlarge_3_0` (4/16GB), large `2xlarge_3_0` (8/32GB) — no exact 8GB tier; verify via `GetBundles`. Regions: `us-east-1/us-east-2/us-west-2/eu-west-1/eu-west-2/eu-central-1/ap-southeast-1/ap-northeast-1/ap-southeast-2`.
- **Extra checklist**: SigV4 implementation validated against AWS published test vectors; reusable `awsSign()` helper; static IP lifecycle tests (no leaked IPs).

## OVH (Effort: Large, Priority: Low)

Most unusual auth (custom SHA1 signature + time sync) and NO instance tags. Low priority — complexity outweighs user base.

- **Auth**: 4 credential fields (`appKey`, `appSecret`, `consumerKey`, `projectId`). Signature `$1$ + SHA1(appSecret + consumerKey + METHOD + URL + BODY + TIMESTAMP)`; headers `X-Ovh-Application/Consumer/Timestamp/Signature`. MUST sync time via `GET /auth/time` (cache ~30s) — clock drift breaks signing. Base `https://{eu|ca|us}.api.ovh.com/v1/cloud/project/{projectId}` (endpoint selection: user choice or region detection — open question).
- **Lifecycle**: `POST/GET/DELETE /instance[/{id}]`, `POST /instance/{id}/shelve|unshelve` (shelve deallocates = cheaper; plain stop still bills — shelve-vs-stop is an open question, unshelve is slower).
- **Cloud-init**: `userData` plain text (limit unresearched).
- **Quirks**: **NO instance tags** — use name-prefix convention (`sam-{nodeId}-...`) + optionally DB mapping; `listVMs(labels)` needs client-side prefix filtering. Flavor and image IDs are per-region UUIDs — resolve dynamically (`GET /flavor?region=`, `GET /image?osType=linux&region=`). Huge status enum (OpenStack-style: `ACTIVE/BUILD/SHELVED/SHUTOFF/...`).
- **Sizes**: small `b3-8` (2/8GB), medium `b3-16` (4/16GB), large `b3-32` (8/32GB) — query UUIDs per region. Regions: `GRA7/GRA11/SBG5/BHS5/DE1/UK1/WAW1/SGP1/SYD1`.
- **Extra checklist**: signature-scheme unit tests against known values, time-sync caching tests, name-prefix filtering tests, multi-endpoint selection.

---

## Success Criteria (per provider)

- [ ] Provider passes the full contract test suite
- [ ] Provider-specific quirks handled (see sections above)
- [ ] All unit tests pass with >90% coverage
