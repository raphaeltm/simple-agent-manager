# Vultr cloud provider — full BYO-key support (infrastructure + deployment volumes)

**Task ID:** 01KY86H88B2NEHT9CCQCQF96EZ · **Idea:** 01KY86EMPSA0XTZGGNAZAA0CEK · **Output branch:** `sam/implement-vultr-fourth-cloud-qf96ez`

## Problem

Add `vultr` as a fourth cloud provider (after hetzner, scaleway, gcp) covering BOTH workspace/task node provisioning AND app-deployment environment nodes + deployment volumes (Vultr Block Storage). Vultr is a **static single-API-key** provider — follow the **Hetzner** credential path (raw token) and the **Scaleway** provider-implementation pattern (async IP, split volumes module, `key=value` tag encoding). Deployment support comes free via the shared abstraction (`deployment-provisioning.ts` → `provisionNode` → `createProviderForUser` → `provider.createVM()`, and `deployment-volumes.ts` for volumes — no provider-specific branches).

## Vultr API facts (verified 2026-07-23 against the `govultr` SDK structs + Vultr docs)

- **Auth:** `Authorization: Bearer <api_key>`, base `https://api.vultr.com/v2`. Validate via `GET /v2/account`.
- **⚠️ PAT IP allowlist:** Vultr Personal Access Tokens have an Access-Control subnet allowlist; users MUST select **"Allow All IPv4/IPv6"** because SAM calls originate from Cloudflare Workers (no static egress IP). Goes in `PROVIDER_HELP.vultr.helpText` + docs. This WILL silently break users otherwise.
- **Instances:** `POST/GET/DELETE /v2/instances`, actions `POST /v2/instances/{id}/{halt|start|reboot}`. Create-req fields: `region, plan, os_id, label, hostname, user_data, tags, backups, activation_email, enable_ipv6, sshkey_id, snapshot_id, app_id, image_id`. Instance response fields: `id, main_ip, status, power_status, server_status, region, plan, os_id, date_created, label, hostname, tags, internal_ip, v6_main_ip`.
- **user_data MUST be base64-encoded** (Workers-safe UTF-8 base64 helper; no Node Buffer).
- **IP is async:** `main_ip = "0.0.0.0"` until ready. `provisionNode` TOLERATES empty IP (`nodes.ts:268-292`) and heartbeat backfill (`node-lifecycle.ts:286-312`) self-heals — both provider-agnostic. Vultr `createVM` does a **short bounded best-effort poll** (`DEFAULT_VULTR_IP_POLL_TIMEOUT_MS`/`_INTERVAL_MS`, configurable) then returns empty (`0.0.0.0`→`''`) if not ready. Never fails create on IP.
- **Triple status:** combine `status` (pending/active/suspended/resizing), `power_status` (running/stopped), `server_status` (none/locked/installingbooting/ok) into `VMStatus` via an explicit tested mapping table.
- **No graceful shutdown — halt only.** `powerOff → halt`, `powerOn → start`.
- **OS ids are mutable ints** — resolve `os_id` dynamically via `GET /v2/os` (`{id:int, name, arch, family}`), matching Ubuntu 24.04 LTS x64 (`DEFAULT_VULTR_OS_NAME`, env-overridable); accept a numeric `config.image` as an explicit os_id override. Cache per provider instance.
- **Create hygiene:** `label`+`hostname`(sanitized) = name, `tags` = `key=value` strings, explicitly `backups:"disabled"`, `activation_email:false`.
- **Delete idempotency:** treat 404 as success (DELETE returns 204 on success).
- **Sizes** (`vc2` Cloud Compute family, stable slugs): small `vc2-2c-4gb` (2 vCPU / 4 GB / 80 GB, ~$20/mo), medium `vc2-4c-8gb` (4 / 8 / 160, ~$40/mo), large `vc2-6c-16gb` (6 / 16 / 320, ~$80/mo). *(Raphaël validates live post-merge; a wrong slug only fails the live create, easily patched.)*
- **Regions** (curated): `ewr` (New Jersey), `ord` (Chicago), `lax` (LA), `ams` (Amsterdam), `fra` (Frankfurt), `lhr` (London), `nrt` (Tokyo), `sgp` (Singapore), `syd` (Sydney). Default **`fra`** (EU bias, matches hetzner fsn1 / scaleway fr-par-1).
- **Block Storage** (`/v2/blocks`): create `{region, size_gb, label, block_type}` (`high_perf` NVMe, min 10 GB / max 10 TB), `POST /v2/blocks/{id}/attach {instance_id, live:true}`, `/detach {live:true}`, resize `PATCH {size_gb}` (grow-only), delete (404-idempotent), get, list (cursor-paginated). Response: `id, region, size_gb, label, block_type, status, attached_to_instance, mount_id, date_created`. **Region-limited** (note in `volumeCapabilities.notes`).
- **Single `label` string on blocks** (NOT k/v labels). SAM never filters volumes by label (`listVolumes` has zero callers; volumes tracked by `providerVolumeId` in D1). Encode the SAM labels `{sam-environment, sam-volume-name}` into the single label via `key=value;key=value` and decode on read for a faithful `listVolumes`/`getVolume` round-trip.
- **Error shape:** `{"error":"<string>","status":<int>}` (top-level `error` is a STRING, no structured code). `classifyVultrError` uses statusCode + message regex: 401/403→auth_error, 429→rate_limited, 503→transient_capacity, 400/422→invalid_config (message `/not available|no capacity|out of stock|sold out/i`→transient_capacity).

## Key design decisions

1. **Credential = single API key, stored RAW** like Hetzner (`serializeCredentialToken('vultr') → fields.token`; `buildProviderConfig('vultr', token) → {provider:'vultr', apiToken:token}`). Snapshot parsers already tolerate raw strings (rule 41).
2. **File-size rule 18:** `vultr.ts` (< 500 lines) + `vultr-volumes.ts` (Scaleway split pattern). Generalize the `key=value` tag encoder into `kv-tags.ts` (DRY) and re-export from `scaleway-tags.ts` (Scaleway behavior unchanged, covered by existing tests).
3. **Constitution XI:** IP-poll timeout/interval + request timeout are constructor params with `DEFAULT_*` constants, env-threadable via `buildProviderConfig` (like Hetzner capacity-retry env).
4. **Volumes: implement for real** (`volumeCapabilities.supported:true`), `high_perf` NVMe, region-limited note.
5. **Onboarding first-run wizard: DEFER** to a follow-up backlog task (binary `hetzner?:scaleway` ternaries need a 3-way restructure). Vultr is fully usable via Settings → Cloud Providers + the unified `CloudProviderConnectFlow` + `CreateWorkspace`. The 5 has-cloud-provider detection gates and CloudProviderConnectFlow's 3 branch-arms ARE done (else vultr-only users are mis-gated / vultr silently becomes a GCP request).

## Implementation checklist

### packages/shared
- [ ] `types/user.ts:69` — add `'vultr'` to `CREDENTIAL_PROVIDERS` (single source of truth; widens `CredentialProvider`, triggers the compile gates).
- [ ] `types/user.ts:105-117` — add `| { provider: 'vultr'; token: string }` to `CreateCredentialRequest`.
- [ ] `constants/providers.ts` — add `vultr` to `PROVIDER_LABELS`, `PROVIDER_HELP` (IP-allowlist helpText), `PROVIDER_LOCATIONS` (9 regions), `PROVIDER_DEFAULT_LOCATIONS` (`fra`). (TS-forced.)
- [ ] `constants/vm-sizes.ts:21` — `PROVIDER_VM_SIZE_VCPUS.vultr = {small:2, medium:4, large:6}` (SILENT — no TS error if missed).
- [ ] `constants/resource-defaults.ts:40` — `PROVIDER_VM_CAPACITY.vultr = {small:{2,4,80}, medium:{4,8,160}, large:{6,16,320}}` (SILENT).
- [ ] `constants/hetzner.ts` — add `DEFAULT_VULTR_REGION='fra'`, `DEFAULT_VULTR_OS_NAME='Ubuntu 24.04 LTS x64'` (env-overridable comments). Re-export from `constants/index.ts`.

### packages/providers
- [ ] `types.ts:285` — add `VultrProviderConfig {provider:'vultr'; apiToken; requestTimeoutMs?; ipPollTimeoutMs?; ipPollIntervalMs?; region?; osName?; logger?}` to `ProviderConfig` union.
- [ ] `kv-tags.ts` (new) — generic `labelsToKvTags`/`kvTagsToLabels`; refactor `scaleway-tags.ts` to re-export (Scaleway unchanged).
- [ ] `vultr-labels.ts` (new) — `encodeVultrBlockLabel`/`decodeVultrBlockLabel` (single-string `k=v;k=v`).
- [ ] `vultr.ts` (new, <500 lines) — full instance lifecycle: create (base64 user_data, tags, os_id resolve, short IP poll), delete (404-idempotent), get, list (cursor paginate + client-side label filter), powerOff(halt)/powerOn(start), validateToken (`GET /v2/account`), triple-status mapping, `classifyVultrError`, delegate volume ops to `VultrVolumeClient`.
- [ ] `vultr-volumes.ts` (new) — `VultrVolumeClient` + `VULTR_VOLUME_CAPABILITIES` (supported, high_perf, min 10/max 10240, growOnly, sameLocation, region-limited note) + create/attach/detach/resize/delete/get/list (label encode/decode, `mount_id`→best-effort `linuxDevice`).
- [ ] `validation.ts` — `VultrInstancePayload`/`VultrBlockPayload` interfaces + `validateVultr{Instance,Instances,Block,Blocks}Response` (mirror scaleway validators).
- [ ] `index.ts:82` — `createProvider` `case 'vultr'` (exhaustive-never gate) + exports (`VultrProvider`, `classifyVultrError`, `VULTR_LOCATIONS`, volume size constants).

### apps/api
- [ ] `services/provider-credentials.ts` — `serializeCredentialToken` `case 'vultr'` (raw token, compile gate) + `buildProviderConfig` `case 'vultr'` (silent default — must add) with env-threaded tuning.
- [ ] `services/validation.ts` — `validateVultrCredentialWithProvider(token, options)` (`GET /v2/account`, Bearer).
- [ ] `routes/credentials.ts` + `routes/projects/credentials.ts` — hetzner-shaped `vultr` branch in `getCloudCredentialFields`; vultr branch in `validateCloudCredentialRequest` **before** the GCP format-only fallthrough; import the validator.
- [ ] `schemas/credentials.ts` — `VultrCredentialSchema` (single token) + add to the `v.variant` array.
- [ ] `schemas/{nodes,workspaces,projects,tasks}.ts` + `schemas/admin.ts:22` — add `'vultr'` to the 5 hardcoded `v.picklist([...])` (SILENT reject if missed).
- [ ] `routes/resolution-status.ts:43` — `vultr: 'Vultr'` display name.
- [ ] MCP tool-definition strings (`tool-definitions-task-tools.ts:162`, `tool-definitions-shared-fields.ts:49`) — add vultr to the example provider list (cosmetic).
- [ ] Verify-only (add tests, no code change expected): catalog route `routes/providers.ts` (generic else-branch), `platform-credentials.ts` (agnostic), `nodes.ts` empty-IP + `resolveHetznerBaseImageOverride`, CC compute consumer, `deployment-provisioning.ts`, `deployment-volumes.ts`.

### packages/cloud-init
- [ ] `generate.ts:236` — add `'vultr'` to `VALID_CLOUD_PROVIDERS` (independent hardcoded copy!) + doc comment at :248. (`template.ts` apt-mirror: vultr safely falls through the `*)` default — no change.)

### apps/web
- [ ] `components/VultrCredentialForm.tsx` (new) — clone `HetznerTokenForm.tsx`, single API-key field, IP-allowlist hint, `provider:'vultr'`.
- [ ] `pages/SettingsCloudProvider.tsx` — import + `vultrCredential` lookup + new `<section>`.
- [ ] `components/CloudProviderConnectFlow.tsx` — add `vultr` to `buildRequest` (before GCP default), `isReady`, and a single-token render block (else vultr silently becomes a GCP request).
- [ ] 5 has-cloud-provider gates → add `|| c.provider === 'vultr'`: `CreateWorkspace.tsx:133`, `OnboardingChecklist.tsx:43`, `onboarding/OnboardingContext.tsx:82`, `onboarding/choose-path/ChoosePathWizard.tsx:103`, `pages/project-chat/useProjectChatState.ts:272`.
- [ ] `pages/AdminPlatformCredentials.tsx` — label map + `<option value="vultr">`.
- [ ] `components/settings-credentials/ConfigurationSection.tsx` — `vultr: 'Vultr'` in `COMPUTE_LABELS` (list is data-driven).
- [ ] Playwright visual audit (rule 17): VultrCredentialForm in SettingsCloudProvider + CloudProviderConnectFlow @ 375px + 1280px, mock data incl. long text / empty / error.
- [ ] Onboarding wizard → **follow-up backlog task** (file it explicitly).

### Docs (same PR, rule 01)
- [ ] Docs content: `guides/self-hosting.mdx` (:20, :288), `reference/roadmap.md` (:59 add to Complete, :94 remove from Planned), `architecture/overview.md` (:6, :45, :303), `architecture/security.md` (:10, :53), `guides/app-deployments.md:87` (volume table → vultr supported), `guides/creating-workspaces.md:75`, `overview.mdx` (:16, :57), `concepts.mdx:50`, `quickstart.md:21`.
- [ ] Marketing: `data/integrations.ts` (new vultr entry + logo svg + relatedSlugs), `components/Roadmap.astro` (:31 add / :51 remove from Planned), `components/Comparison.astro:5`, `components/HowItWorks.astro:6`, `pages/self-host/index.astro:101`, `pages/enterprise/{compliance,cost-control}.astro:39`. (`pages/integrations/index.astro` data-driven, auto.)

## Test plan
- **Providers unit suites** (mocked fetch, >90% coverage, exact-payload assertions): `vultr.ts` lifecycle (create body incl. base64 user_data + tags + resolved os_id + backups/activation_email; IP poll happy + timeout→empty; delete 404-idempotent; halt/start; triple-status mapping matrix; list cursor pagination + label filter), `vultr-volumes.ts` (create/attach/detach/resize grow-only-reject/delete-404/get/list label round-trip), `classifyVultrError` matrix, `vultr-labels` encode/decode round-trip, `kv-tags` (+ Scaleway re-export unchanged), factory `case 'vultr'`.
- **Contract test** `tests/contract/vultr-contract.test.ts` reusing `runProviderContractTests`.
- **apps/api**: credential CRUD (vultr create → stored raw token, validate bogus key → sanitized error, nothing stored); **rule-28 resolution fallback matrix** (active-project → user → platform → null; inactive-row blocks fallback); `resolve-credential-source` vultr; **rule-35 vertical-slice node-provisioning** with Vultr HTTP mocked at the boundary (create node → provider.createVM called with correct payload → node persisted, empty-IP tolerated); deployment-volume slice (createVolume label encoding); catalog omits vultr without a credential.
- **cloud-init**: `VALID_CLOUD_PROVIDERS` accepts vultr; generation with `provider:'vultr'`.
- **web**: VultrCredentialForm behavioral test (render + submit + delete); Playwright visual audit.

## Acceptance criteria
- [ ] `pnpm lint && typecheck && test && build` green.
- [ ] Vultr provider implements the full `Provider` interface incl. real volume ops; >90% coverage on new provider code.
- [ ] Credential create/validate/delete works for vultr (raw-token, bogus key → clean sanitized error, nothing stored).
- [ ] rule-28 fallback matrix + rule-35 vertical-slice tests present and passing.
- [ ] All UI surfaces (Settings form, CloudProviderConnectFlow, CreateWorkspace gate) render/wire vultr; visual audit clean at 375/1280.
- [ ] Docs + marketing enumerations updated; Vultr moved out of "Planned".
- [ ] Onboarding-wizard follow-up backlog task filed.
- [ ] Staging: deploy green, ZERO regressions in Hetzner/dashboard/projects/settings, no-key vultr checks pass (form wired; bogus key → sanitized error; catalog omits vultr w/o credential). Live Vultr provisioning explicitly DEFERRED to Raphaël's production BYO-key validation (authorized 2026-07-23).

## Merge protocol (authorized 2026-07-23)
BYO-key exception: merge with CI green (incl. SonarCloud + Preflight) + all reviewers PASS/ADDRESSED + staging regression + no-key checks green. PR MUST document that live Vultr provisioning is validated post-merge in production by Raphaël with his own key, and include his manual production checklist (add real key → create Vultr node → workspace → run agent → delete node; then deployment env + Vultr volume → tear down).

## References
- Idea 01KY86EMPSA0XTZGGNAZAA0CEK · `tasks/backlog/2026-02-16-additional-cloud-providers.md` (Vultr section) · `packages/providers/src/scaleway.ts` + `scaleway-volumes.ts` (impl pattern) · `packages/providers/src/hetzner.ts` (single-token) · `apps/api/src/services/provider-credentials.ts`
- Rules: 18 (file size), 28 (credential fallback tests), 35 (vertical slice), 11 (fail-fast), 41 (credential snapshot resilience), 47 (control-loop I/O budget), 01 (doc sync), 17 (UI visual), 42 (tracked follow-ups)
