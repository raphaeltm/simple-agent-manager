# GCP boot disk scales with the machine (slice 1 of "make SAM use GCP first")

SAM task 01M7D36PKX3YHK4CTW8T1F4YV4. Ideas 01M76GEHBVB0EXG619ZAZCN327 (boot disk), 01M77QAMDKN1FSSFKMYJK63X22 (T2D quota).

## Problem

`GcpProvider` creates every VM with a fixed 50 GB boot disk (`diskSizeGb = 50` constructor default,
`packages/providers/src/gcp.ts`). The catalog advertises the same 50 GB (`gcpOfferingsFromMachineTypes`,
`bootDiskGb: this.diskSizeGb`). A t2d-standard-8 (8 vCPU / 32 GB) therefore reports 51,200 MB of disk and
admits about one workspace with the default 40,960 MB disk reservation. Since 2026-11-11 SAM-project tasks
rejected running GCP nodes 29 times for "disk reservation budget would be exceeded" and 12 times for
"disk pressure threshold reached"; each rejection provisioned another VM, three t2d-standard-8 VMs used the
24-vCPU T2D quota, and new work fell back to Hetzner. `GCP_DISK_SIZE_GB` is declared and documented but nothing
reads it.

## Decision (made by Raphaël; do not re-ask)

Boot disk = max(floor, perVcpu × vCPUs). Defaults: 20 GB per vCPU, 50 GB floor (t2d-standard-8 → 160 GB,
standard-4 → 80 GB, ≤2 vCPU → 50 GB). Both are admin-editable runtime settings with typed defaults.
Remove the dead `GCP_DISK_SIZE_GB`.

## Research Findings

- Disk flows: offering `diskGb` → `providerInstanceOfferingDbValues` → candidate `provider_instance_disk_gb`;
  candidate `provider_instance_boot_disk_size_gb` is operator config, preserved across refreshes, NULL for every
  production GCP candidate (prod D1, 54 active GCP candidates in Raphaël's pool, all `50/null`).
- Plan → VM: `nativePlanFromRow` (runtime-allocation.ts) passes `bootDiskSizeGb` (NULL here) and
  `resources.diskGb` (= candidate disk). `GcpProvider` then uses `nativeConfig.bootDiskSizeGb ?? this.diskSizeGb`,
  ignoring `resources.diskGb`.
- Reuse authority: `resolveReusableNodeCapacitySnapshot` builds the snapshot from the CURRENT candidate, and
  `buildPlacementAuthoritySqlPredicate` compares `c.provider_instance_disk_gb` against that same value and
  `c.provider_instance_boot_disk_size_gb IS n.provider_instance_boot_disk_size_gb`. Candidate publication does not
  bump `capacity_pools.revision`. So changing candidate `disk_gb` (and leaving boot-disk NULL) keeps running
  50 GB nodes inside authority; setting candidate boot-disk to a number would NOT (node NULL ≠ candidate 160).
  Node capacity for admission comes from the node's own columns (`nodeOfferingSatisfiesReservation`), so old
  nodes keep 50 GB.
- `node-allocation-validation.ts` compares `capacity_authority_generation` (includes candidate disk) only when a
  pending node provisions: a plan created before the refresh fails once with "authority changed" and replans.
- Static GCP catalog (`SIZE_MAP` in gcp-metadata.ts) advertises 50 GB for small/medium/large (1/2/4 vCPU).
- Prices: `gcpMachineTypeHourlyPrice` prices cores + RAM only; boot disk cost is not in the shown price.
  Price table comes from Cloud Billing SKUs (`gcp-pricing.ts`), stored by `gcp-price-table.ts`.
- Six `new GcpProvider(...)` sites in the API (`provider-credentials.ts` ×5, `provider-catalogs-build.ts` ×1) plus
  `createProvider` in `packages/providers/src/index.ts`.
- Admin settings registry already has a `gcpCatalog.*` group (`admin-settings-gcp-catalog-definitions.ts`);
  `resolveAdminSetting` is per-isolate cached (one D1 read per cache window, not per request).
- SSD quota: regional SSD_TOTAL_GB 20,480. Pool max_nodes = 8 (prod). Worst case 8 × t2d-standard-16 (16 vCPU →
  320 GB) = 2,560 GB in one region. Independently, disk ≤ 20 GB × regional CPUS quota (200) = 4,000 GB.
- Candidate rows republish on capacity pool GET with ensure and on credential lifecycle events, not on a timer.

## Implementation Checklist

- [ ] providers: `GcpBootDiskPolicy` + `gcpBootDiskSizeGb(vcpus, policy)` with DEFAULT constants (20/50)
- [ ] providers: GcpProvider takes the policy instead of a flat `diskSizeGb`; catalog offerings size disk per type
- [ ] providers: createVM disk precedence: explicit `bootDiskSizeGb` > plan `resources.diskGb` > policy(vCPUs)
- [ ] providers: static GCP offerings and `SIZE_MAP` storage agree with the default policy (large → 80 GB)
- [ ] providers: price includes the boot disk (pd-balanced capacity SKU per region) when its price is known
- [ ] api: `gcpCatalog.bootDiskGbPerVcpu` and `gcpCatalog.bootDiskMinGb` admin settings, typed defaults
- [ ] api: one helper builds GcpProvider with the resolved policy at every construction site
- [ ] remove `GCP_DISK_SIZE_GB` (env.ts, .env.example, configuration.md, env-reference skill, runtime-tunables
      baseline, shared `DEFAULT_GCP_DISK_SIZE_GB`); document the new settings
- [ ] tests: offering → candidate → plan → createVM body agree (160 GB for t2d-standard-8)
- [ ] tests: existing 50 GB node stays inside reuse authority after candidate disk becomes 160 (real SQL)
- [ ] tests: admin setting overrides change offering + VM size; floor applies to small types
- [ ] tests: price includes disk; missing disk price keeps machine-only price with a distinct price source

## Acceptance Criteria

- [ ] A t2d-standard-8 offering advertises 160 GB; candidate row disk 160 / boot-disk NULL; createVM body
      `diskSizeGb: "160"`; observed node capacity 160.
- [ ] A running node created with 50 GB stays reusable (inside authority) after the refresh, with 50 GB capacity.
- [ ] Changing the two admin settings changes the advertised and created size without a deploy.
- [ ] Shown price includes the boot disk cost.
- [ ] `GCP_DISK_SIZE_GB` no longer appears in code or docs.
- [ ] Staging: a real GCP VM boots with the scaled disk (checked at GCP and in node capacity), two default
      workspaces placed on it, then cleaned up.

## References

- packages/providers/src/gcp.ts, gcp-catalog.ts, gcp-pricing.ts, gcp-native-instance.ts, gcp-metadata.ts
- apps/api/src/services/provider-credentials.ts, provider-catalogs-build.ts, admin-settings-gcp-catalog-definitions.ts
- packages/scheduler-core/src/placement-resolver-capacity-reuse.ts, apps/api/src/services/placement-authority.ts (read only; PR #2693 owns it)
- Rules: 07 (dynamic runtime settings), 59, 62, 74, 81
