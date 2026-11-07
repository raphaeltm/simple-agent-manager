# GCP zones: validate by shape, list VMs across every zone

PR 2a of the provider-priority work (idea `01M6NXTF2RQ5QXHM7YZ4ZF0XBK`). Raphaël (2026-11-06):
dynamic Google pricing and regions are in scope, and "hardcoding is not acceptable". This PR
removes the hardcoded zone gates. PR 2b adds the live catalog (prices, machine types and the zones
they exist in).

## Problem

GCP zones were an 8-entry hardcoded list in two places (`PROVIDER_LOCATIONS.gcp` in shared, and
`GCP_LOCATIONS` in providers), and both acted as gates:

- `isValidLocationForProvider('gcp', zone)` rejected every zone outside the 8. It is used by
  placement (`placement-resolver-capacity.ts` `normalizeCapacityCandidate` silently drops the
  candidate), task/node creation (`routes/nodes.ts`, `placement-field-resolution.ts`), project
  update and the GCP credential default-zone check.
- `GcpProvider.listVMs` walked only the 8 zones. Its callers use the result as an inventory:
  orphan reconciliation (`provider-orphan-reconciliation-core.ts`) and allocation recovery
  (`node-allocation-recovery.ts`). A VM in any other zone was invisible to both.
  (`strict-node-deletion.ts` also calls `listVMs`, but only for Hetzner providerless VMs.)
- `listVMs` also skipped a zone that returned 503, turning a partial inventory into "no VM there".

## Research findings

- Compute `instances.aggregatedList` returns every zone in one paginated call. Unreachable zones
  come back as `items[scope].warning.code = 'UNREACHABLE'`. `NO_RESULTS_ON_PAGE` is normal.
- Multi-expression filters on `aggregatedList` use the documented parenthesised AND form.
- `findInstanceByIdOrName` already falls back to the aggregated list, so delete/power work in any
  zone.
- Label values passed to `listVMs` by every caller are lowercase (`buildNodeProviderLabels`
  lowercases node ids; installation id, environment label and incarnation UUID are lowercase).
- `orderedLocationsForProvider` (`default-capacity-pool-helpers.ts`) has no callers: dead code.
- Deferred to PR 2b (live catalog): the credential form's zone picker (`GcpCredentialForm.tsx`
  `GCP_ZONES`) and `ScalingSettings` still offer the labelled suggestions. Both stay valid; the
  live catalog will supply the real zone list.

## Implementation checklist

- [x] `isValidLocationForProvider`: GCP validated by `GCP_ZONE_PATTERN`; others unchanged
- [x] `describeValidLocations` for error messages (GCP describes the shape, not a list)
- [x] `listVMs` uses the aggregated list; label filter built by `gcpLabelFilter`, which refuses
      values outside GCP's label charset instead of escaping them
- [x] Unreachable zone ⇒ throw (fail closed)
- [x] Remove dead `fetchPaginatedGcpInstances`, `validateGcpInstancesList`,
      `isToleratedZoneListError`, `orderedLocationsForProvider`
- [x] Tests: shared shape validation (new zones accepted, malformed rejected, other providers
      unchanged); provider listVMs (all zones, filter, injection refused, unreachable fails closed,
      pagination, errors); orphan reconciliation reaches an owned orphan in a new zone and skips
      foreign/unlabelled; placement keeps a candidate in a new zone
- [x] Surgical reverts: restricting `listVMs` to the labelled zones reddens the orphan test and
      two listVMs tests; removing the GCP shape branch reddens the placement test
- [x] Docs: `google-cloud.md`

## Acceptance criteria

- [x] A GCP zone outside the labelled list is accepted everywhere a location is validated
- [x] An owned SAM VM in any zone is found by orphan reconciliation
- [x] A partial (unreachable-zone) listing fails closed
- [x] Other providers' location validation is unchanged

## Staging

Waived by Raphaël for this work (session `eecddba8`, 2026-11-07). GCP is not connected on staging.
