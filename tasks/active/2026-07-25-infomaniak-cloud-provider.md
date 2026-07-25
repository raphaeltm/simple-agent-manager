# Infomaniak Public Cloud provider — BYO-key compute and deployment volumes

**Task ID:** 01KYBDSGH85QB4W2PF6QZHWE72 · **Output branch:** `sam/implement-ship-infomaniak-public-zhwe72`

## Problem

Add Infomaniak Public Cloud as a fully supported SAM BYO-key provider for workspace/task nodes and app-deployment environment nodes with persistent deployment volumes. The integration must use explicit Keystone application credentials, implement the full provider VM and Cinder volume lifecycle, expose safe region-aware capabilities, and cover all API, web, cloud-init, documentation, and marketing surfaces.

Live provider-key testing is explicitly deferred to Raphaël after merge. All mocked, no-key, bogus-key, local, staging-regression, visual, review, and CI gates remain mandatory.

## Research findings

- Infomaniak exposes OpenStack services through Keystone v3. Official documentation recommends application credentials with an ID and one-time secret, using `https://api.pub1.infomaniak.cloud/identity/v3`.
- Full infrastructure automation requires both `reader` and `member` roles in `dc4-a`; credential help text must state this clearly. SAM should not accept ambiguous username/password credentials.
- The Keystone token response service catalog supplies region-specific Nova, Cinder, Glance, and Neutron endpoints. Runtime response validation is required; endpoint defaults and overrides must remain configurable.
- Official compute documentation confirms Nova server creation with image, flavor, `ext-net1`, cloud-init/user-data-capable standard images, and public IP addresses.
- Official Cinder documentation confirms independent persistent volumes can be created, attached to one VM, detached, preserved, and reattached to a replacement VM while retaining data. This satisfies SAM's replacement-node-safe deployment-volume model.
- Cinder volumes are grow-only. The safe SAM capability is detach-first resize because Infomaniak documents `in-use` resize failures and attached-extension API/version caveats.
- Device names must not be requested during attach. Guests should discover volumes through `/dev/disk/by-id` using the Cinder volume ID fragment.
- Infomaniak currently documents `dc3-a` and `dc4-a`; images/flavors are mutable catalog resources and must be resolved dynamically by configured names rather than unsafe fixed IDs.
- Vultr provider commit `5c06da973` and `tasks/archive/2026-07-23-vultr-cloud-provider.md` define the latest complete cross-repository provider touchpoint map.
- Concurrent DigitalOcean and UpCloud tasks are active. Reconcile provider registries, docs, and UI enumerations with current `origin/main` before PR creation and again before merge.

## Implementation checklist

### Shared configuration and provider core

- [x] Add `infomaniak` to shared credential/provider types, labels, help, locations/defaults, VM CPU/capacity maps, and exported configurable defaults.
- [x] Add explicit Infomaniak config fields for application credential ID/secret, auth URL, region, interface, network, image, flavor mapping, volume type, polling/request timeouts, and operation budgets.
- [x] Implement a narrowly scoped Infomaniak OpenStack client with Keystone token/catalog discovery and runtime validation for Keystone, Nova, Glance, Neutron, and Cinder response shapes.
- [x] Implement full VM lifecycle: validate credentials, resolve image/flavor/network, create with cloud-init user data, read/list/delete, power on/off, status mapping, public IPv4 discovery, bounded polling, safe/idempotent deletion, and error classification.
- [x] Implement real Cinder volume operations: create/list/get/delete, Nova attach/detach, grow-only detach-first resize, region checks, attachment mapping, stable device-discovery notes, and safe deletion semantics.
- [x] Wire provider factory exports and full contract coverage.

### API, runtime, and cloud-init

- [x] Add explicit credential schemas/routes/validation/storage serialization and provider resolution/config construction without logging secrets.
- [x] Add runtime environment overrides and `.env.example` documentation for all operational defaults required by project rules.
- [x] Update provider picklists, resolution/catalog/admin schemas, task/workspace/project/node routes, MCP field descriptions, and deployment provisioning/volume vertical slices.
- [x] Add `infomaniak` to cloud-init provider validation and generation tests.

### Web, docs, and marketing

- [x] Add a clear Infomaniak application-credential form with separate ID/secret fields, role/region guidance, validation/delete behavior, and connect/settings/admin support.
- [x] Update provider readiness gates, workspace creation, onboarding detection, project settings, and deployment-provider selection surfaces.
- [x] Add behavioral tests and a local Playwright visual audit at 375×667 and 1280×800, including normal, long, empty, many, error, special-character, and minimal-content scenarios where applicable.
- [x] Update public documentation and marketing/provider enumerations, including compute and deployment-volume support and a production live-key validation checklist.

### Validation and shipping

- [x] Add exact-payload mocked provider unit tests, response-validation tests, contract tests, API credential/provisioning/volume vertical-slice tests, cloud-init tests, and web behavior tests.
- [x] Run lint, typecheck, tests, builds, coverage/quality gates, and task-completion validation.
- [x] Complete and address reviews from task-completion-validator, cloudflare-specialist, security-auditor, ui-ux-specialist, env-validator, doc-sync-validator, constitution-validator, and test-engineer.
- [x] Rebase on current main and reconcile concurrent provider additions before PR and merge.
- [x] Deploy to staging; verify no-key/bogus-key API and UI behavior, existing-provider regressions, and changed web surfaces. Live Infomaniak provisioning remains deferred.
- [ ] Open PR with review evidence and production checklist, pass all CI, merge, and monitor the matching production deploy success run by merge SHA.

## Acceptance criteria

- [x] Infomaniak is selectable and usable anywhere SAM accepts a managed cloud provider.
- [x] Credentials are explicit Keystone application credential ID/secret pairs and are encrypted/stored/redacted consistently with existing provider secrets.
- [x] Provider implements SAM's complete VM interface with validated OpenStack response shapes and configurable operational defaults.
- [x] Deployment volumes are truthfully supported with replacement-node-safe detach/reattach, safe deletion, same-region enforcement, stable device discovery guidance, and detach-first grow-only resize semantics.
- [x] Tests prove exact outgoing payloads and reject malformed Keystone/Nova/Cinder responses rather than trusting casts.
- [x] Web surfaces are accessible, mobile-first, visually audited, and do not misroute Infomaniak requests to another provider.
- [x] Public docs and marketing accurately enumerate Infomaniak compute and volume support.
- [x] All required reviewers pass or have findings addressed; CI and staging/no-key regression checks are green.
- [x] PR documents deferred live production validation: add Infomaniak credentials; create node; create workspace; run agent; delete node; create deployment environment with Infomaniak volume; verify mount and persistence across replacement; tear down.
- [ ] PR is merged only after syncing concurrent provider work, and the production deployment for the merge SHA succeeds.

## References

- SAM library: `global-sam-compatible-volume-cloud-providers-2026-07-01.md`
- SAM library: `hetzner-competitive-volume-mount-shortlist-2026-06-27.md`
- SAM library: `hetzner-price-competitive-cloud-providers-2026-06-27.md`
- `tasks/archive/2026-07-23-vultr-cloud-provider.md`
- Commit `5c06da973`
- Infomaniak Public Cloud: <https://www.infomaniak.com/en/hosting/public-cloud>
- Infomaniak application credentials: <https://docs.infomaniak.cloud/identity/applications_credentials/>
- Infomaniak block storage: <https://docs.infomaniak.cloud/block_storage/basic_operations/>
- Infomaniak Cinder policies: <https://docs.infomaniak.cloud/identity/policies/cinder/>
- Infomaniak instance creation: <https://docs.infomaniak.cloud/compute/instances/instance_creation_and_deletion/>
- Infomaniak standard images: <https://docs.infomaniak.cloud/compute/images/standard_images/>
