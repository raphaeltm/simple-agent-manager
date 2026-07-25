# UpCloud cloud provider — BYO credentials, nodes, and deployment volumes

**Task ID:** 01KYBDQCYJ0PFJWBZHXNCK04AV
**Output branch:** `sam/implement-ship-upcloud-sam-ck04av`

## Problem

Add UpCloud as a SAM BYO-key compute provider for workspace/task nodes and app-deployment environment nodes. Implement independent persistent deployment volumes with safe create, inspect, attach, detach, grow, preserve, and delete behavior.

UpCloud is SAM's first HTTP Basic-auth cloud provider. Its API uses nested response wrappers and models boot disks and detachable data storage through the same storage resource API, so credential serialization, runtime validation, server deletion, and volume lifecycle boundaries must be explicit and thoroughly tested.

## Research findings

### Current official UpCloud API behavior (reverified 2026-07-25)

- API base: `https://api.upcloud.com/1.3`; authentication is HTTP Basic using a dedicated API subaccount username and password. Credential validation uses `GET /account`.
- Servers: `POST /server`, `GET /server`, `GET /server/{uuid}`, `POST /server/{uuid}/start`, and soft shutdown through `POST /server/{uuid}/stop`.
- Server deletion requires the server to be stopped. `DELETE /server/{uuid}?storages=1` deletes attached storage, while the default `storages=0` preserves it. SAM must delete workspace-node boot storage but must never accidentally destroy separately tracked deployment data volumes.
- Creation from a cloud-init template uses `server.user_data`; template images come from `GET /storage/template` and are mutable UUID-backed resources, so resolve the configured Ubuntu template dynamically by title/template type unless an explicit UUID is supplied.
- Plans and zones are discoverable (`GET /plan`, `GET /zone`). Use supported documented plan names for SAM defaults while keeping them configurable and validating provider responses at runtime.
- Server states are `started`, `stopped`, `maintenance`, and `error`. Public IPv4 is in the nested `ip_addresses.ip_address` collection.
- Normal storage resources are created per zone with `POST /storage`; same-zone attachment is required. `maxiops` supports 1–4096 GiB and optional encryption at rest.
- Attach uses `POST /server/{uuid}/storage/attach` with a `virtio` address; detach can identify the resource by storage UUID. Linux device discovery is best-effort from the returned server storage-device address.
- Resize is `PUT /storage/{uuid}`, grow-only, and may require the attached server to be stopped. Provider resize changes only the block device; filesystem growth remains the deployment runtime's responsibility.
- Storage deletion must be idempotent and must reject deletion while still attached unless the caller has detached it through the normal lifecycle.
- UpCloud label objects are native key/value pairs for both servers and storages. SAM-managed server and deployment-volume labels can round-trip without a lossy encoding.

### SAM integration map

- Vultr PR #1663 / commit `5c06da973` is the latest complete provider addition and identifies 83 touched files across shared metadata, provider factory/config, API schemas and credential routes, cloud-init validation, web onboarding/settings/admin surfaces, tests, docs, and marketing.
- Deployment-node provisioning is provider-agnostic through `deployment-provisioning.ts` → `provisionNode` → `createProviderForUser` → `Provider.createVM`.
- Deployment volumes are provider-agnostic through `deployment-volumes.ts` and the `Provider` volume methods; no UpCloud-only orchestration branch should be necessary.
- Credential secrets are encrypted per user. UpCloud needs a structured `{username,password}` serialization rather than the raw-token Hetzner/Vultr path, with snapshot/backward-compatibility parsing tests.
- UpCloud responses require dedicated runtime validators, following the Vultr validation pattern rather than unsafe casts.
- The full compatibility bar from SAM library research is: independent API-managed block volume, normal Linux block device, preserved across node replacement, same-location detach/reattach, complete lifecycle, safe deletion, and grow-only resizing where available.

### Coordination

- `origin/sam/add-digitalocean-sams-fifth-2sdcn3` exists without an open PR at research time. No open DigitalOcean or Infomaniak provider PR exists as of 2026-07-25.
- Re-fetch and rebase onto current `origin/main` before opening and again before merging. Reconcile provider registry, docs, and marketing conflicts without dropping concurrent providers.

## Implementation checklist

### Shared types and metadata

- [x] Add `upcloud` to the credential provider union and `{provider:'upcloud'; username; password}` create request.
- [x] Add UpCloud label/help text, verified public locations, European default location, VM vCPU maps, and capacity maps.
- [x] Add configurable UpCloud API, plan, image-title, region, polling, shutdown, and request-timeout defaults without hardcoded operational values.

### Provider package

- [x] Add an UpCloud provider config variant and exhaustive factory/export wiring.
- [x] Implement Workers-safe HTTP Basic authentication and sanitized provider error classification.
- [x] Add runtime validators for nested account, plan, zone, template, server, server-list, storage, and storage-list responses.
- [x] Implement VM creation with dynamic cloud-init template resolution, nested `user_data`, root storage clone, labels, networking, and bounded public-IP readiness polling.
- [x] Implement get/list with SAM-label filtering, status mapping, power on, soft power off, and idempotent safe server deletion that removes boot storage without deleting separately tracked deployment volumes.
- [x] Implement real volume create/list/get/delete, attach/detach, grow-only resize, same-zone checks, encrypted maxiops defaults, Linux-device discovery notes, and idempotent/safe deletion behavior.
- [x] Keep provider implementation files within project size limits and extract focused shared helpers only where they remove real duplication.

### API, runtime configuration, and cloud-init

- [x] Add structured UpCloud credential serialization/deserialization and provider config construction with environment overrides.
- [x] Add UpCloud credential schemas, create/update/delete/validation routes, project credential routes, and sanitized bogus-credential behavior.
- [x] Add UpCloud to node/workspace/project/task/admin schema picklists, provider catalog/resolution status, MCP provider enumerations, and environment typing/examples.
- [x] Verify project → user → platform credential fallback and inactive-row blocking for UpCloud.
- [x] Add UpCloud to cloud-init provider validation and generation coverage.
- [x] Prove provider-agnostic workspace-node provisioning and deployment-volume vertical slices through UpCloud HTTP boundary mocks.

### Web, docs, and marketing

- [x] Add a username/password UpCloud credential form with create/update/delete behavior.
- [x] Wire UpCloud through Settings → Cloud Providers, the connect flow, all has-cloud-provider gates, workspace creation, onboarding, project chat, admin platform credentials, and credential configuration labels.
- [x] Ensure no UpCloud branch can fall through into GCP or single-token request shapes.
- [x] Update public architecture/security/concepts/quickstart/self-hosting/workspace/app-deployment docs and provider support tables.
- [x] Add UpCloud integration metadata/logo and update marketing/provider enumerations and roadmap status.
- [x] Run the mandatory local Playwright visual audit at 375×667 and 1280×800 with normal, long, empty, many-item, loading, and error states; assert no horizontal overflow.

### Tests and validation

- [x] Add provider unit tests with mocked fetch and exact request/payload assertions for auth, discovery, create/get/list/delete, status mapping, polling, start/stop, and every volume operation.
- [x] Add response-validation and error-classification matrices, malformed-response cases, timeout cases, pagination/label behavior, idempotent 404s, unsafe attached-volume deletion rejection, same-zone rejection, and shrink rejection.
- [x] Reuse the provider contract suite for UpCloud.
- [x] Add API credential CRUD/validation tests, credential-resolution tests, provisioning and deployment-volume vertical-slice tests, cloud-init tests, and web behavior tests.
- [x] Run lint, typecheck, all tests, build, migration/binding quality gates, and new-code coverage.
- [x] Run required specialist reviews and address every critical/high finding: task-completion-validator, cloudflare-specialist, security-auditor, ui-ux-specialist, env-validator, doc-sync-validator, constitution-validator, and test-engineer.
- [x] Deploy to staging after local/reviewer gates; validate no-key/bogus-key UpCloud UI/API flows and provider-regression behavior. Exercise the existing platform Hetzner path for cloud-init/node regression because no real UpCloud credential is available.

## Acceptance criteria

- [ ] `upcloud` is selectable and usable across shared, provider, API, runtime, cloud-init, web, admin, docs, and marketing surfaces.
- [ ] UpCloud implements the complete SAM `Provider` interface for VM lifecycle and real independent deployment volumes.
- [ ] Structured credentials remain encrypted, never leak into logs/errors/responses, and bogus credentials are rejected without persistence.
- [ ] Server deletion intentionally deletes the boot/root storage while preserving SAM-tracked deployment data volumes; volume deletion is explicit and safe.
- [ ] Same-zone attach, best-effort device discovery, detach/preserve/reattach semantics, and grow-only resizing are represented in capabilities and tested.
- [ ] Runtime validators reject malformed nested UpCloud responses.
- [ ] Contract, provider, API vertical-slice, cloud-init, and web tests pass with comprehensive mocked boundary coverage.
- [ ] Local visual audit is clean on mobile and desktop; full quality suite, specialist reviews, staging deployment, and no-key regression checks are green.
- [ ] PR documents that real-key provisioning is deferred to Raphaël's production validation and includes this checklist:
  - Add UpCloud credentials.
  - Create an UpCloud node.
  - Create a workspace and run an agent.
  - Delete the workspace/node.
  - Create a deployment environment with an UpCloud volume.
  - Verify mount and persistence through node replacement/restart.
  - Tear down the deployment environment and resources.
- [ ] Branch is rebased against current provider additions before PR and merge; CI is green; no critical/high review finding remains; PR is merged and the production deploy succeeds for the merge head SHA.

## References

- `tasks/backlog/2026-02-16-additional-cloud-providers.md`
- `tasks/archive/2026-07-23-vultr-cloud-provider.md`
- SAM library `01KWENW41T8SV647HMGPE0V88J`
- SAM library `01KW4CZVR4X6GBBAZJ95T8VXEV`
- `packages/providers/src/vultr.ts`
- `packages/providers/src/vultr-volumes.ts`
- `apps/api/src/services/provider-credentials.ts`
- `apps/api/src/services/deployment-volumes.ts`
- UpCloud Servers API: https://developers.upcloud.com/1.3/8-servers/
- UpCloud Storages API: https://developers.upcloud.com/1.3/9-storages/
- UpCloud Zones API: https://developers.upcloud.com/1.3/5-zones/
- UpCloud pricing: https://upcloud.com/pricing/
- Rules: `.claude/rules/01-doc-sync.md`, `02-quality-gates.md`, `09-task-tracking.md`, `17-ui-visual-testing.md`, `19-external-service-integration.md`, `28-credential-resolution-fallback-tests.md`, `35-vertical-slice-testing.md`, `41-credential-snapshot-resilience.md`, `47-control-loop-io-budget.md`

## Merge protocol

Raphaël explicitly authorizes merge after local validation, all required specialist reviews, staging/no-key verification, and CI are green. Missing real UpCloud credentials are covered by the approved BYO-key exception and do not block merge. Live provider provisioning and persistence validation are deferred to Raphaël's production account after deployment.
