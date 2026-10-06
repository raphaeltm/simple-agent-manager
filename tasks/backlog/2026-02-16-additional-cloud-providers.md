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

## Linode / Akamai (Effort: Medium)

Straightforward REST; unique `X-Filter` header filtering and required `root_pass`.

- **Auth**: `Authorization: Bearer <token>`, base `https://api.linode.com/v4`. Validate via `GET /profile`.
- **Lifecycle**: `POST/GET/DELETE /linode/instances`, `POST /linode/instances/{id}/shutdown|boot`.
- **Cloud-init**: nested `metadata.user_data`, base64-encoded.
- **Quirks**: `root_pass` REQUIRED when creating from image — generate cryptographically random, never stored. Public IP available immediately in create response (`ipv4[0]`) — no polling. Tag filtering via `X-Filter: {"tags": {"$contains": "sam-managed"}}` JSON header. Rate limit 800 req/min (429 + `Retry-After`).
- **Sizes**: small `g6-standard-2`, medium `g6-standard-4`, large `g6-standard-8` (verify via `GET /linode/types`). Regions: `us-east/us-central/us-west/eu-west/eu-central/ap-south/ap-northeast/ap-southeast`.

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

## Reconciliation — 2026-09-23 (weekly queue audit)

Four of the seven providers in the original consolidated file have shipped and their sections
were removed from this file:

| Provider           | Evidence in `main`                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| DigitalOcean       | `packages/providers/src/digitalocean.ts` (+ `-volumes`, `-tags`, `-metadata`, `validation-digitalocean.ts`) |
| Vultr              | `packages/providers/src/vultr.ts` (+ `-volumes`, `-labels`, `-metadata`, `validation-vultr.ts`)             |
| UpCloud            | `packages/providers/src/upcloud.ts` (+ `upcloud-utils.ts`, `validation-upcloud.ts`)                         |
| GCP Compute Engine | `packages/providers/src/gcp.ts` (+ `gcp-native-instance.ts`, `gcp-metadata.ts`)                             |

Infomaniak also shipped (`packages/providers/src/infomaniak.ts`) and was never in this file.

**What is left:** Linode / Akamai, AWS Lightsail, and OVH. Nothing else in this file is open.

## Success Criteria (per provider)

- [ ] Provider passes the full contract test suite
- [ ] Provider-specific quirks handled (see sections above)
- [ ] All unit tests pass with >90% coverage
