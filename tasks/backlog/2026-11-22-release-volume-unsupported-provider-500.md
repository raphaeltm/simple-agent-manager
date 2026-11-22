# Release with a named volume returns 500 when credential resolution picks a provider without block volumes

## Problem

`POST /api/projects/:projectId/environments/:envId/releases` with a Compose file that declares a
named volume returns `500 INTERNAL_ERROR` when the user's resolved cloud credential is a provider
whose `volumeCapabilities.supported` is `false` (GCP).

`createEnvironmentVolume()` (`packages/app-deployment/src/deployment-volumes.ts`) throws a plain
`Error("Provider \"gcp\" does not support block volumes")`, reached through
`createMissingDeclaredVolumes()` → `prepareManifestVolumes()`
(`apps/api/src/routes/deployment-release-submission.ts`). The error escapes to `app.onError`, so
the caller gets a 500 with no actionable message.

Declared volumes also pass no `targetProvider`, so resolution falls through project → user →
platform credentials and picks GCP for a user who has both a Hetzner and a GCP credential, even
though Hetzner supports volumes.

## Context

Found 2026-11-22 during hosted staging verification of PR #2974. The staging smoke user has active
Hetzner and GCP user credentials. A fresh environment in "Deployment Test 1" with a `postgres`
service on a named `pgdata` volume got a 500; `platform_errors` row
`a54f2676-673c-4004-a8dc-49435626c948` holds the stack. Not caused by PR #2974.

## Acceptance Criteria

- [ ] An unsupported-provider or size-limit volume failure returns a 4xx with a message naming the
      provider and the remedy, not a 500
- [ ] Decide and implement provider choice for declared volumes when the resolved provider lacks
      volume support (prefer a volume-capable credential, or refuse clearly)
- [ ] Route test through the real release endpoint with a GCP-resolving credential
