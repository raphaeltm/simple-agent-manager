# Provider-orphan sweep never runs when the platform cloud credential is GCP

## Problem

`resolveProvider()` in `apps/api/src/scheduled/provider-orphan-reconciliation-core.ts` builds the
provider with `buildProviderConfig(credential.provider, …)`. For `gcp`,
`buildProviderConfig` (`apps/api/src/services/provider-credential-codecs.ts`) always throws
"GCP credentials require buildGcpProviderConfig() — cannot use buildProviderConfig() directly".
The catch logs `provider_orphan.credential_resolution_failed` and the sweep skips with
`credential-resolution-failed`. On an install whose platform cloud credential is GCP, orphaned
provider VMs are therefore never reconciled.

## Context

Seen on the self-hosted test box (sam-box, https://app.vmtest.sam2.party) during box round R4,
2026-11-12: the error appears on every `*/5 * * * *` sweep (for example 14:40:00Z, 15:25:00Z,
15:30:00Z). The box's platform credential is GCP (workload identity). It is not specific to
self-hosting; any deployment with a GCP platform credential takes the same path.

## Acceptance Criteria

- [ ] The orphan sweep builds a GCP provider through `buildGcpProviderConfig()` (the same
      path node provisioning uses) when the platform credential is GCP
- [ ] A test drives the sweep with a GCP platform credential and asserts it lists provider VMs
      instead of skipping with `credential-resolution-failed`
- [ ] Control: a Hetzner (token) platform credential still goes through `buildProviderConfig`
- [ ] Verified on a box or staging with a GCP credential: no `credential_resolution_failed` log on the sweep
