# Hetzner Capacity Retry Policy

## Problem

Hetzner VM provisioning sometimes returns HTTP 422 with error messages suggesting invalid server type/region combinations, but in practice these are transient capacity issues. Waiting briefly and retrying often succeeds.

Currently, `HetznerProvider.createVM()` only retries on 412 (placement errors) with location fallback. 422 errors are thrown immediately as non-retryable, causing VM provisioning to fail when the issue is just temporary capacity.

## Research Findings

### Current Code Path
- `packages/providers/src/hetzner.ts:createVM()` — main provisioning method
- `packages/providers/src/provider-fetch.ts:providerFetch()` — HTTP wrapper that throws `ProviderError` with statusCode
- Existing retry: 412 errors trigger location fallback (primary → primary+delay → other locations)
- 422 errors currently throw immediately at line 140 (`throw err`)

### Error Classification
- **412**: Hetzner placement error — server cannot be placed in that datacenter. Retrying in another location helps.
- **422**: Can mean either:
  - Transient capacity: "server type not available in location" when capacity is temporarily exhausted
  - Permanent config error: truly invalid server_type name, invalid image, etc.
- **Conservative approach**: Only retry 422s whose error message matches known capacity-related patterns. Do not retry all 422s.

### Known Hetzner 422 Capacity Messages
- Messages containing "unavailable" or "currently not available" for a server type/location
- Messages containing "no capacity" or "not enough resources"
- Messages containing "server_type" combined with "location" (type/location mismatch that is often transient)

### Existing Patterns
- Retry delay configurable via constructor: `placementRetryDelayMs`
- Exported defaults: `DEFAULT_PLACEMENT_RETRY_DELAY_MS = 3_000`
- `HetznerProviderConfig` type in `types.ts` has config fields for retry behavior

## Implementation Checklist

- [ ] Add `isTransientCapacityError()` helper to identify retryable 422s by message pattern
- [ ] Add capacity retry constants: `DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS` (15s), `DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS` (120s), `DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS` (5)
- [ ] Add constructor params for capacity retry config (initial delay, max delay, max attempts)
- [ ] Update `HetznerProviderConfig` in `types.ts` with new optional fields
- [ ] Implement exponential backoff retry loop in `createVM()` that wraps the existing placement logic
- [ ] Log each capacity retry with: provider, region, server type, attempt number, delay, sanitized error
- [ ] Distinguish final "capacity exhausted" from "invalid configuration" in error messages
- [ ] Export new defaults from `index.ts`
- [ ] Add tests: transient 422 succeeds after retry
- [ ] Add tests: permanent/non-capacity 422 does not retry
- [ ] Add tests: max attempts exhausted throws with clear message
- [ ] Add tests: exponential backoff timing
- [ ] Add tests: configurable retry params
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test` in providers package
- [ ] Update `HetznerProviderConfig` doc comments

## Acceptance Criteria

- [ ] 422 errors matching known capacity patterns are retried with exponential backoff
- [ ] 422 errors NOT matching capacity patterns are thrown immediately (no retry)
- [ ] Retry policy: ~15s initial, exponential increase, ~2min max per wait, bounded max attempts
- [ ] All retry params configurable via constructor (matching existing pattern)
- [ ] Each retry attempt is logged with provider, region, server type, attempt#, delay, error
- [ ] Final error after exhaustion clearly says "capacity exhausted after N attempts" (distinct from config error)
- [ ] Non-capacity 422s throw immediately with original error message
- [ ] All existing 412 placement retry tests still pass
- [ ] New tests cover: transient success, permanent failure, timing, configuration

## References

- Knowledge graph: "Hetzner VM provisioning can return HTTP 422 errors that appear to mean no capacity..."
- `packages/providers/src/hetzner.ts` — main implementation
- `packages/providers/src/types.ts` — ProviderError, HetznerProviderConfig
- `.claude/rules/03-constitution.md` — Principle XI: no hardcoded values
