# GCP nodes boot from pd-balanced instead of the API default (pd-standard)

SAM task 01M76EVW6ARTTEJD9TPHKHDXGZ; evidence on idea 01M72Q4M63SKBETRBC6VQN40YS.

## Problem

`GcpProvider.createVM` set no boot disk type, so Compute Engine gave every node an API-default
`pd-standard` disk. Measured on a production GCP node: ~445 synchronous 4 KiB writes/s, 61 ms
average write since boot. Full workspace builds take ~10 min on Hetzner and 17-26 min on GCP
e2-standard-4. CPU (2 physical Broadwell cores) is the larger cause; this change addresses only
the disk.

## Research findings

- The insert body is built in `packages/providers/src/gcp.ts` (`createVMUnclassified`). The zone
  is `nativeConfig.location` (`config.location || defaultLocation`), used for both the insert URL
  and `machineType`. Zone fallback happens in the API TaskRunner, which calls `createVM` again
  with the next offering's location, so using the same `zone` variable covers it.
- `GcpProviderConfig` exists, but every API caller builds `new GcpProvider(projectId,
tokenProvider, defaultZone)` directly. An override field would have no setter: not added
  (no dead code). Named constant `DEFAULT_GCP_BOOT_DISK_TYPE` only.
- Pricing (`gcp-pricing.ts`, `gcp-catalog.ts`) prices vCPU + RAM only; the Google Cloud guide
  already says "The price excludes the boot disk." Documented and consistent: no change.
- `gcp.ts` was 515 lines (rule 18): the boot disk object moved into `gcpBootDisk()` in
  `gcp-native-instance.ts`, so `gcp.ts` shrinks.
- `pd-balanced` draws on regional `SSD_TOTAL_GB`. An exhausted quota surfaces as
  `QUOTA_EXCEEDED` / "Quota 'SSD_TOTAL_GB' exceeded", classified `quota_exceeded`
  (`classifyGcpError`); the TaskRunner moves to a later provider tier or parks/fails the task
  (`node-provisioning-failure.ts`). No error-handling change.

## Checklist

- [x] `DEFAULT_GCP_BOOT_DISK_TYPE = 'pd-balanced'` in `gcp-metadata.ts`
- [x] `gcpBootDisk(zone, sourceImage, sizeGb)` sets `initializeParams.diskType` to `zones/<zone>/diskTypes/pd-balanced`
- [x] `createVM` uses it with the insert zone
- [x] Tests through `createVM`: default, non-default zone, stockout then another zone, explicit size, SSD quota category, Hetzner control
- [x] Discrimination: removing `diskType` fails 4 tests; a fixed zone fails the 2 zone tests
- [x] One docs bullet in `apps/www/src/content/docs/docs/guides/google-cloud.md`
- [x] Local review: task-completion-validator, constitution-validator, doc-sync-validator, test-engineer all PASS; LOW notes applied (docs wording/placement, stockout fixture asserts code+message)
- [ ] PR, CI, local review, CodeRabbit wait, merge, Deploy Production watched

## Acceptance criteria

- [x] New GCP nodes request `pd-balanced` in the zone they are created in
- [x] Other providers' request bodies unchanged
- [ ] Deployed to production (staging skipped by Raphaël's explicit instruction for this task)

## Notes

- Pre-existing, out of scope: `GCP_DISK_SIZE_GB` is documented (`reference/configuration.md`) and declared in `apps/api/src/env.ts` but nothing passes it to `GcpProvider`; recorded as a SAM idea.
- CodeRabbit (Major): Hyperdisk-only series (N4, C4, C4A, N4D, ...) reject Persistent Disk. Google's docs do not say what `instances.insert` picks for an unset type on those series, so `pd-balanced` is now sent only for series in `GCP_PD_BALANCED_BOOT_SERIES` (e2, n1, n2, n2d, t2d, c2, c2d, c3, c3d). Every other series keeps sending no type, as before. Tests: 4 Hyperdisk-only cases (red with the guard removed) and 5 PD-series controls.
