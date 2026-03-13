# Scaleway Provider Improvements

**Created**: 2026-03-13
**Context**: Findings from test-engineer review of PR #366 (ScalewayProvider implementation)

## Problem

Several gaps identified in ScalewayProvider test coverage and a potential zone-mismatch bug in the implementation.

## Issues

### 1. Zone mismatch bug (HIGH)
`deleteVM`, `getVM`, `listVMs`, `powerOff`, `powerOn` all use `this.zone` (constructor zone) for API calls. But `createVM` accepts `config.location` which can differ from the constructor zone. If a VM was created in `nl-ams-1` but the provider was constructed with `fr-par-1`, operations on that VM will target the wrong zone URL.

**Fix options:**
- Store the zone per-VM and pass it through (requires changing the `Provider` interface to accept zone in operations)
- Accept this as a known limitation and document that all VMs for a provider instance must be in the same zone (matches current Hetzner behavior where datacenter is per-provider)

### 2. Missing contract test
No `tests/contract/scaleway-contract.test.ts` equivalent to `hetzner-contract.test.ts`. The shared contract suite verifies Provider interface shape and idempotency.

### 3. Minor test gaps
- Cloud-init `Content-Type: text/plain` header not asserted in creation test
- `getVM` non-404 error (e.g., 500) not tested for throw behavior
- `powerOn` has no failure test (only happy path)
- Image resolution zone not verified when `config.location` differs from constructor zone
- `listVMs` tag params format not structurally verified

## Acceptance Criteria

- [ ] Decide on zone-mismatch approach (fix or document limitation)
- [ ] Add contract test for ScalewayProvider
- [ ] Add missing negative/edge case tests
