# DigitalOcean cloud provider — full BYO-key support (infrastructure + deployment volumes)

**Task ID:** 01KYBDMV58ZK5ANVZ91JBQF5TT · **Prior failed task:** 01KY8JTXF169T0KWDNFW2SDCN3 · **Idea:** 01KY8JSQHXJT5SR3Z4QM46V2QK · **Output branch:** `sam/implement-ship-digitalocean-sam-bqf5tt`

## Problem

Add `digitalocean` as a **fifth cloud provider** (after hetzner, scaleway, gcp, vultr) covering BOTH workspace/task node provisioning AND app-deployment environment nodes + deployment volumes (DO Block Storage). DigitalOcean is a **static single-API-key** provider — follow the **Hetzner/Vultr** credential path (raw token) and the **Vultr** provider-implementation pattern (async IP short-poll, split volumes module, flat tag array). Deployment support comes free via the shared abstraction (`deployment-provisioning.ts` → `provisionNode` → `createProviderForUser` → `provider.createVM()`, and `deployment-volumes.ts` for volumes — no provider-specific branches).

**The merged Vultr PR #1663 (squash commit `5c06da973`, merged 2026-07-23) is the site map** (83 touchpoints). The archived plan `tasks/archive/2026-07-23-vultr-cloud-provider.md` documents the pattern + review findings (hostname sanitize trailing-hyphen, bounded IP-poll wall time, provider-fetch error shapes, list-pagination truncation warn, positiveOr on poll timeouts) — baked in from the start.

## DigitalOcean API facts (verified 2026-07-23 against the DO OpenAPI spec)

- **Auth:** `Authorization: Bearer <token>`, base `https://api.digitalocean.com/v2`. Validate via `GET /v2/account`. No IP-allowlist trap (unlike Vultr).
- **Token scopes:** helpText → generate at `https://cloud.digitalocean.com/account/api/tokens` with **Full Access** (or custom scopes covering droplet, block_storage, tag, image, region, size, account, actions).
- **Droplets:** `POST/GET/DELETE /v2/droplets`, actions `POST /v2/droplets/{id}/actions {type}`. Create fields: `name` (sanitized), `region`, `size` (slug), `image` (slug or int), `user_data` (**PLAIN TEXT**, max 64 KiB), `tags` (colon-encoded), `backups:false`, `ipv6:false`, `monitoring:false`. Actions return **async action objects**; power ops fire-and-forget (parity with Hetzner/Vultr — SAM does not await power completion).
- **Image is a STABLE slug**: `ubuntu-24-04-x64` (`DEFAULT_DIGITALOCEAN_IMAGE`, env-overridable; accept numeric `config.image` as explicit id override). No mutable-os_id subsystem.
- **Droplet `id` is an INTEGER** — `String(id)` (Hetzner/validation `requireNumber` → map to string).
- **IP is async:** no public IPv4 until `status=active`; extract from `networks.v4[]` entry with `type:"public"`. Short bounded best-effort poll (`DEFAULT_DIGITALOCEAN_IP_POLL_TIMEOUT_MS`/`_INTERVAL_MS`, env-configurable, hard-bounded wall time) then return empty; `provisionNode` empty-IP tolerance + heartbeat backfill self-heal.
- **Status mapping** (single field): `new`→initializing, `active`→running(if networks ready)/starting, `off`→off, `archive`→off/terminated. Explicit tested table.
- **Power:** `power_off` (hard), `power_on`.
- **Delete idempotency:** 404 → success (204 on delete).
- **⚠️ Tags charset:** letters/numbers/**colons**/dashes/underscores — `=` is NOT allowed. Colon variant (`key:value`, split on first `:`). Parameterize `kv-tags.ts` with a separator + `digitalocean-tags.ts` (charset validate, fail-fast on unencodable per rule 11). Scaleway/Vultr `=` behavior unchanged.
- **List pagination:** page-based (`?page=&per_page=200`, max 200). Bounded page cap + truncation warn + client-side label filter.
- **Sizes** (Basic/shared-CPU, stable slugs): small `s-2vcpu-4gb` (2/4/80, ~$24/mo), medium `s-4vcpu-8gb` (4/8/160, ~$48/mo), large `s-8vcpu-16gb` (8/16/320, ~$96/mo).
- **Regions** (curated 10): `fra1` (Frankfurt, default), `ams3`, `lon1`, `nyc1`, `nyc3`, `sfo3`, `tor1`, `sgp1`, `blr1`, `syd1`.
- **Block Storage** (`/v2/volumes`): create `{name, region, size_gigabytes, tags?}`; min 1 GiB / **max 16384 GiB**; attach/detach/resize via `POST /v2/volumes/{id}/actions` (`{type, droplet_id, region, size_gigabytes}`) — **async action objects**: poll to `completed` with bounded env budget (`DEFAULT_DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS`), fail sanitized on `errored`/timeout. Resize grow-only (client-guard). Delete 404-idempotent. Region-scoped (`requiresSameLocation:true`), no region caveat.
- **⚠️ Volume `name`:** lowercase letters/numbers/hyphens only, ≤64 chars, must start with a letter. SAM names volumes `sam-${environmentId}-${name}` (UPPERCASE ULID env id; `name` is `[a-z0-9-]{1,63}`). Provider **lowercases + sanitizes + truncates to 64** for DO name, round-trips EXACT SAM name via a `sam-name:<value>` tag (Vultr `VULTR_VOLUME_NAME_LABEL_KEY` pattern). SAM tracks by `providerVolumeId` in D1 → round-trip only serves `listVolumes`/`getVolume` fidelity.
- **linuxDevice is DETERMINISTIC:** `/dev/disk/by-id/scsi-0DO_Volume_<name>` (from the DO volume name). Note in `volumeCapabilities.notes`.
- **Error shape:** structured `{id:"not_found", message:"...", request_id}`. `provider-fetch.ts` already falls back to top-level `json.message` → clean messages **with no change**. `classifyDigitalOceanError`: 401/403→auth_error, 429→rate_limited, 5xx→transient, 422 w/ `/not available|no capacity|out of stock|sold out|unavailable/i`→transient_capacity, else 400/422→invalid_config.

## Key design decisions

1. **Credential = single API key, stored RAW** (`serializeCredentialToken('digitalocean') → fields.token`; `buildProviderConfig('digitalocean', token) → {provider:'digitalocean', apiToken}`).
2. **File-size rule 18:** `digitalocean.ts` (<500) + `digitalocean-volumes.ts` + `validation-digitalocean.ts` + `digitalocean-tags.ts`. Colon-tag encoding shared via parameterized `kv-tags.ts`, not copy-pasted.
3. **Constitution XI:** request/IP-poll/action-poll timeouts + region + image are constructor params with `DEFAULT_*` constants, env-threadable via `buildProviderConfig` (`DIGITALOCEAN_*` on `Env` + `.env.example`).
4. **Volumes: implement for real** (`supported:true`, min 1 / max 16384, growOnly, sameLocation, deterministic device path).
5. **Onboarding first-run wizard: DEFER** — append DigitalOcean to existing `tasks/backlog/2026-07-23-vultr-onboarding-wizard-parity.md` (do NOT duplicate). Fully usable via Settings → Cloud Providers + `CloudProviderConnectFlow` + `CreateWorkspace`.
6. **DRY the has-cloud gates:** extract `TOKEN_COMPUTE_PROVIDERS` + `hasByocComputeCredential()` in `packages/shared/src/constants/providers.ts`; replace the 5 repeated `hetzner||scaleway||vultr` gates. Preserve GCP's current exclusion EXACTLY (GCP gate tracked separately in `tasks/backlog/2026-07-23-credential-routes-preexisting-hardening.md` — do not change GCP behavior).

## Implementation checklist

### packages/shared

- [x] `types/user.ts` — `'digitalocean'` in `CREDENTIAL_PROVIDERS` + `| { provider: 'digitalocean'; token: string }` in `CreateCredentialRequest`.
- [x] `constants/providers.ts` — `PROVIDER_LABELS`, `PROVIDER_HELP` (Full-Access PAT helpText), `PROVIDER_LOCATIONS` (10 regions), `PROVIDER_DEFAULT_LOCATIONS` (`fra1`); **`TOKEN_COMPUTE_PROVIDERS` + `hasByocComputeCredential()`** (DRY helper).
- [x] `constants/vm-sizes.ts` — `PROVIDER_VM_SIZE_VCPUS.digitalocean = {small:2, medium:4, large:8}`.
- [x] `constants/resource-defaults.ts` — `PROVIDER_VM_CAPACITY.digitalocean = {small:{2,4,80}, medium:{4,8,160}, large:{8,16,320}}`.
- [x] `constants/hetzner.ts` — `DEFAULT_DIGITALOCEAN_REGION='fra1'`, `DEFAULT_DIGITALOCEAN_IMAGE='ubuntu-24-04-x64'`; re-export from `constants/index.ts`.

### packages/providers

- [x] `types.ts` — `DigitalOceanProviderConfig` in `ProviderConfig` union.
- [x] `kv-tags.ts` — parameterize with a separator (default `=`; existing `labelsToKvTags`/`kvTagsToLabels` become thin wrappers — Scaleway/Vultr unchanged).
- [x] `digitalocean-tags.ts` (new) — colon encode/decode + charset validate (fail-fast) + `sam-name` volume-name round-trip key.
- [x] `digitalocean.ts` (new, <500) — droplet lifecycle per API facts; delegate volumes to `DigitalOceanVolumeClient`; `DIGITALOCEAN_LOCATIONS` + meta; SIZE_CONFIGS; `classifyDigitalOceanError`; `mapDigitalOceanStatus`; `validateToken`.
- [x] `digitalocean-volumes.ts` (new) — `DigitalOceanVolumeClient` + `DIGITALOCEAN_VOLUME_CAPABILITIES`; create (name sanitize + `sam-name` tag), attach/detach/resize with bounded action polling, delete-404-idempotent, get, list (tag decode + region filter), deterministic `linuxDevice`.
- [x] `validation-digitalocean.ts` (new) — droplet/volume/action payload validators (integer id, `networks.v4`, page meta).
- [x] `index.ts` — `createProvider` `case 'digitalocean'` (exhaustive-never gate) + exports.

### apps/api

- [x] `services/provider-credentials.ts` — `serializeCredentialToken` + `buildProviderConfig` digitalocean cases; `DigitalOceanRuntimeEnv`; env threading.
- [x] `services/validation.ts` — `validateDigitalOceanCredentialWithProvider` (`GET /v2/account`, Bearer).
- [x] `routes/credentials.ts` + `routes/projects/credentials.ts` — digitalocean branch in `getCloudCredentialFields` + `validateCloudCredentialRequest` **BEFORE the GCP fallthrough**.
- [x] `schemas/credentials.ts` — `DigitalOceanCredentialSchema` + variant; `'digitalocean'` in the 5 picklists (`tasks,admin,projects,workspaces,nodes`).
- [x] `routes/resolution-status.ts` — `digitalocean: 'DigitalOcean'`.
- [x] MCP tool-definition provider example strings (cosmetic).
- [x] `env.ts` + `.env.example` — `DIGITALOCEAN_*` tunables.

### packages/cloud-init

- [x] `generate.ts` — `'digitalocean'` in `VALID_CLOUD_PROVIDERS` + doc comment.

### apps/web

- [x] `DigitalOceanCredentialForm.tsx` (new) — thin wrapper over `SingleTokenCredentialForm` (widen `SingleTokenProvider`).
- [x] `SettingsCloudProvider.tsx` — credential lookup + section.
- [x] `CloudProviderConnectFlow.tsx` — `buildRequest` (before GCP), `isReady`, single-token render block; grid `sm:grid-cols-2` (5 providers).
- [x] 5 has-cloud gates → shared DRY helper (`hasByocComputeCredential`).
- [x] `AdminPlatformCredentials.tsx` label + option; `settings-credentials/ConfigurationSection.tsx` `COMPUTE_LABELS`.
- [x] Playwright visual audit (rule 17): form + connect flow @ 375/1280, long-text/empty/error.

### Docs + marketing (same PR, rule 01)

- [x] Docs: `self-hosting.mdx`, `reference/roadmap.md`, `architecture/overview.md`, `architecture/security.md`, `guides/app-deployments.md`, `guides/creating-workspaces.md`, `guides/idea-execution.md`, `guides/local-development.md`, `overview.mdx`, `concepts.mdx`, `quickstart.md`.
- [x] Marketing: `data/integrations.ts` + `public/images/integrations/digitalocean.svg`, `Roadmap.astro`, `Comparison.astro`, `HowItWorks.astro`, `self-host/index.astro`, `enterprise/{compliance,cost-control}.astro`.

## Test plan (mirror Vultr suites 1:1)

- **Providers unit** (>90% coverage, exact-payload): droplet lifecycle (create body: PLAIN user_data + colon tags + image slug + backups/ipv6/monitoring false; integer-id String; IP poll happy + timeout→empty hard-bounded; delete 404; power_off/on; status matrix incl. `networks.v4` public extraction; 2-page pagination + truncation warn + label filter), volumes (name sanitize + `sam-name` round-trip; attach/detach/resize action-poll happy + timeout + errored; resize grow-only + max cap; delete-404 discriminating; deterministic linuxDevice), `classifyDigitalOceanError` matrix, colon-tags encode/decode + charset fail-fast round-trip, factory case.
- **Contract** `tests/contract/digitalocean-contract.test.ts` (`runProviderContractTests`).
- **apps/api:** credential CRUD (raw token; bogus → sanitized error, nothing stored); **rule-28 fallback matrix** (active-project → user → platform → null; inactive-row blocks fallback); resolve-credential-source; **rule-35 vertical provisioning slice** (DO HTTP mocked → exact createVM payload → node persisted, empty-IP tolerated); deployment-volume slice (name lowercasing + tag encoding); catalog omits digitalocean without credential.
- **cloud-init:** VALID_CLOUD_PROVIDERS accepts digitalocean; generation with `provider:'digitalocean'`.
- **web:** form + connect-flow behavioral (incl. GCP-fallthrough guard + validate race-guard); Playwright visual audit.
- **provider-fetch:** DO `{id, message}` error → clean message (locks contract; no code change).

## Acceptance criteria

- [x] `pnpm lint && typecheck && test && build` green; migration/wrangler quality gates pass.
- [x] Full `Provider` interface incl. real volume ops; >90% coverage on new provider code.
- [x] Credential create/validate/delete works (raw token; bogus → clean sanitized error, nothing stored).
- [x] rule-28 fallback matrix + rule-35 vertical-slice tests present + passing.
- [x] All UI surfaces render/wire digitalocean; visual audit clean @ 375/1280.
- [x] Docs + marketing enumerations updated.
- [x] Onboarding-wizard parity backlog task extended (not duplicated).
- [x] Staging deployment and no-key/bogus-key UI/API regression checks pass; a platform-backed non-DigitalOcean workspace provisions, heartbeats, is reachable, and is cleaned up. Live DigitalOcean provisioning remains explicitly deferred to Raphaël’s production validation with his own key.

### Verification evidence (2026-07-25)

- Full local lint, typecheck, test, build, migration, Durable Object migration, Wrangler binding, and provider coverage gates passed.
- Pull request #1670 carries the full specialist matrix, preflight classification, staging evidence, and production-owner checklist.
- DigitalOcean Playwright audit passed 15/15 at 375 px, 390 px, and 1280 px across Settings, Connections, admin credentials, and workspace availability.
- Staging deploy run 30140818283 passed for rebased SHA 7d4030c58, including 12/12 workflow smoke tests.
- Authenticated no-key/bogus-key staging check passed: Settings rendered Full Access guidance; API returned a sanitized 400; the token was not stored; UI displayed the validation alert.
- Enabled Hetzner platform fallback provisioned temporary node 01KYBKCW4XGAJKYX46A1FEE8FX in nbg1; it resolved to Hetzner, obtained a public IP and healthy heartbeat. Workspace 01KYBKHPHBKFVQNE82R56S0R2D created its runtime in recovery fallback mode and its public endpoint reached the auth boundary (401). Workspace and node cleanup both returned 200.
- Rebased onto main after Infomaniak landed; combined provider allowlists, schemas, credential gates, cloud-init, factory coverage, UI surfaces, and documentation preserve both providers. Post-rebase monorepo typecheck, test, build, lint, quality gates, provider coverage, staging deploy/smoke, and full Playwright visual audit passed.
- Reconciled the final tree after UpCloud landed on main; DigitalOcean and UpCloud coexist across registries, credentials, cloud-init, UI, tests, and documentation. Combined provider (509), cloud-init (188), API (6335), and web (2812) tests pass.
- Live DigitalOcean provisioning remains deferred to Raphaël post-merge using his own Full Access PAT, per the authorized protocol below.

## Merge protocol (authorized 2026-07-23)

/do dispatch = explicit merge authorization. BYO-key exception: merge with CI green (incl. SonarCloud + Preflight) + all reviewers PASS/ADDRESSED + no-key coverage complete + staging/no-key regression evidence. PR MUST document that live DigitalOcean provisioning is validated **post-merge in production by Raphaël with his own DO key** (Full Access PAT → create DO node → workspace → run agent → delete node; then create a deployment environment with a DigitalOcean volume → verify mount and persistence → tear down). After merge, monitor the matching successful Deploy Production run by merge head SHA (ignoring skipped duplicates) + confirm production health + feature code in the served bundle.

## References

- Idea `01KY8JSQHXJT5SR3Z4QM46V2QK` · Blueprint `tasks/archive/2026-07-23-vultr-cloud-provider.md` · Vultr PR #1663 / `5c06da973` (site map) · `packages/providers/src/vultr.ts` + `vultr-volumes.ts` + `vultr-labels.ts` + `kv-tags.ts` · `apps/api/src/services/provider-credentials.ts` · `apps/api/src/services/deployment-volumes.ts:225-235`
- Rules: 18 (file size), 28 (credential fallback), 35 (vertical slice), 11 (fail-fast), 41 (snapshot resilience), 01 (doc sync), 17 (UI visual), 42 (tracked follow-ups), 03 (Constitution XI)
