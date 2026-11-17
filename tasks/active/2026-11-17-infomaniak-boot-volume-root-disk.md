# Infomaniak nodes: boot from a SAM-sized Cinder volume instead of the 20 GB flavor root disk

**Issue:** #2842 (external report, treated as untrusted research material)
**SAM idea:** 01M7MBKET31ATPC7G0SPBMGEVD
**Task:** 01M7MBZ5XAGC5E84DES53HSF0Q, branch `sam/fix-infomaniak-20-gb-3hsf0q`

**HOLD: DRAFT PR ONLY.** The brief for the task that owns this PR says to prepare a draft PR and
not mark it ready, merge it, or deploy it to production. This hold stays until a human lifts it.

## Problem

Self-hosted Infomaniak nodes on `a4-ram8-disk20-perf1` (dc4-a) fill their 20 GB root disk after a
few devcontainer builds, and new workspaces then fail (the reporter measured 98% use).

Verified in upstream code at `e5c5aa4f7`:

- `packages/providers/src/infomaniak.ts`: every legacy size has `storageGb: 20`; `createVM` calls
  `assertIncludedBootDiskCapacity` and sends `server.imageRef` with no `block_device_mapping_v2`,
  so the VM boots on the flavor's local 20 GB disk.
- `vm()` derives observed disk only from `flavor.disk`.
- The catalog (`listInstanceOfferings` → `getProviderCatalogOfferings`) advertises 20 GB, which
  becomes the pool candidate's `provider_instance_disk_gb`; admission trusts
  `observed_provider_instance_disk_gb` (`workspace-admission-sql.ts`).
- No Nova microversion header is sent at all (requests default to the base 2.1 API), so the
  reporter's "SAM requests 2.47" is fork-specific. `volume_type` in `block_device_mapping_v2`
  requires 2.67 (Nova microversion history), so it must not be sent.

This verifies the provisioning mechanism, not the reporter's live disk measurement.

## Research findings

1. Nova base API (2.1) accepts `block_device_mapping_v2` with `boot_index`, `uuid`,
   `source_type: image`, `destination_type: volume`, `volume_size`, `delete_on_termination`;
   `imageRef` is not required when booting from volume. → checklist: build the mapping, omit
   `imageRef` and `volume_type`.
2. A volume-booted server reports `image: ""`, and `flavor.disk` still reports the flavor's
   local disk (20), which is not the root. → checklist: observed disk for volume-booted servers
   comes from server metadata SAM writes at create (`sam-root-disk-gb`, the key the reporter's
   fork already uses, so their existing nodes map without migration); missing/malformed → unknown,
   never the flavor value. Image-booted (legacy) servers keep `flavor.disk`.
3. Pool plans carry the candidate's disk as `resources.diskGb` (`nativePlanFromRow`). GCP's
   `defaultBootDiskSizeGb` uses it so the VM matches what the node row records. → reuse that
   pattern (`legacyBootDiskSizeAuthority: 'provider-default'`).
4. Catalog disk must equal created disk: live catalog (`createCatalogProvider`), static fallback
   (`getStaticProviderCatalogOfferings` / `staticCatalogOptions`), and provisioning
   (`provider-credentials.ts`) all build Infomaniak providers. → one setting resolved for all.
5. Policy 9017df94: new tunables are admin settings, not Worker env vars. GCP precedent:
   `gcpCatalog.bootDiskMinGb`. → admin setting `infomaniak.bootVolumeGb`.
6. Default: 80 GB proposed by the reporter. Evaluated against peers at 4 vCPU / 8 GB: Hetzner
   medium 80 GB, UpCloud medium 80 GB, GCP policy 20 GB/vCPU → 80 GB. Accept 80 as a flat default;
   admins can change it. No cost claim is made.
7. Separately managed data volumes are unaffected: boot volumes are created by Nova with no SAM
   labels, so SAM volume list/delete by labels never selects them; `deleteVolume` refuses
   attached volumes anyway. `delete_on_termination: true` makes Nova delete the boot volume with
   the server.
8. Existing nodes: not migrated. Image-booted legacy nodes keep reporting `flavor.disk`.
9. New failure mode: Cinder quota/volume creation failure turns the server to `ERROR` after the
   create call. Today `ERROR` maps to `initializing` (pre-existing, all build failures). Recorded
   as a validation gap; not changed here.

## Implementation checklist

- [ ] Split `infomaniak.ts` (796 lines) before adding: parsers/constants/size configs to
      `infomaniak-metadata.ts`; boot-volume helpers to `infomaniak-boot-volume.ts`
- [ ] Shared constants `DEFAULT_INFOMANIAK_BOOT_VOLUME_GB` (80), `INFOMANIAK_BOOT_VOLUME_MIN_GB`
      (20), `INFOMANIAK_BOOT_VOLUME_MAX_GB`
- [ ] `InfomaniakProviderOptions.bootVolumeSizeGb` / `InfomaniakProviderConfig.bootVolumeSizeGb`,
      passed by `createProvider`; invalid values rejected at construction
- [ ] Sizes and `listInstanceOfferings` advertise the boot volume size
- [ ] `createVM`: default from plan `resources.diskGb` (native) else provider size; explicit
      `bootDiskSizeGb` honoured and validated (integer, min, max); `block_device_mapping_v2`
      boot volume with `delete_on_termination: true`; no `imageRef`, no `volume_type`, no
      microversion header; metadata `sam-root-disk-gb`
- [ ] `vm()`: volume-booted → metadata disk or unknown; image-booted → flavor disk
- [ ] Static `INFOMANIAK_SIZE_CONFIGS` and `PROVIDER_VM_CAPACITY.infomaniak` storage = default
- [ ] Admin setting `infomaniak.bootVolumeGb`; resolved for catalog (live + static fallback) and
      every provisioning provider build
- [ ] Docs: self-hosting / admin settings / .env.example note
- [ ] Tests: createVM payload (default, plan, explicit, invalid), get/list mapping (volume with
      metadata, volume without/malformed metadata, legacy image boot), offerings disk, contract
      tests updated, API threading tests

## Acceptance criteria

- [ ] A new Infomaniak VM boots from a Cinder volume of the configured size that Nova deletes with
      the server
- [ ] Catalog disk, created volume size and observed disk agree
- [ ] Legacy image-booted nodes keep their observed disk
- [ ] Invalid explicit sizes fail before any provider request
- [ ] No `volume_type` or microversion header is sent
- [ ] Draft PR with `Closes #2842`, hold recorded; live Infomaniak validation gap recorded

## Validation gaps

- No Infomaniak credentials are available to this agent; no live Infomaniak provisioning was run.
