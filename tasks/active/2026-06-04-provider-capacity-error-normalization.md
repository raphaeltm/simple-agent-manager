# Provider Capacity Error Normalization + Time-Bounded Retry

## Problem

When a cloud provider is out of capacity for a requested VM size in a region, the provisioning attempt fails instantly — no retry, no fallback. Users lose ~30 min per incident cleaning up dead nodes.

**Root cause**: `provider-fetch.ts` parses the provider error response but only keeps the human-readable `error.message` string, discarding the structured `error.code`. The `isTransientCapacityError()` function in `hetzner.ts` decides retry-eligibility by regex-matching the message against `TRANSIENT_CAPACITY_PATTERNS`. Hetzner returns capacity exhaustion as HTTP 422 with the misleading message `"unsupported location for server type"`, which matches none of the patterns — classified "permanent" — `createVM` throws on first attempt.

**Evidence**: Production D1 shows `large`/`nbg1` provisioned fine at 02:38 while another `large`/`nbg1` got the 422 at 05:46 — same size + same location = transient capacity. 47 occurrences over ~1 month.

## Research Findings

### Current Architecture
1. `ProviderError` (`types.ts:207`): carries `providerName`, `statusCode`, `message`, `context` — no structured error code
2. `providerFetch()` (`provider-fetch.ts:45-68`): parses `json.error.message` from provider response, discards `json.error.code`
3. `isTransientCapacityError()` (`hetzner.ts:54`): regex on message string, only for 422
4. `HetznerProvider.createVM()` (`hetzner.ts:135`): capacity retry loop using `isTransientCapacityError()`
5. Retry config: `capacityRetryInitialDelayMs=15s`, `capacityRetryMaxDelayMs=120s`, `capacityRetryMaxAttempts=5`

### Provider Error Contracts (researched)
- **Hetzner**: Returns `{ error: { code: "resource_unavailable", message: "..." } }` for capacity issues. The `code` field is the structured signal. HTTP 422 with code `resource_unavailable` = capacity. Other 422 codes (`invalid_input`, `uniqueness_error`) = permanent. HTTP 429 = rate limited.
- **Scaleway**: Returns `{ message: "...", type: "not_found"|"invalid_request_error"|... }`. Capacity exhaustion returns HTTP 503 with type `transient` or specific messages. No `code` field — uses `type`.
- **GCP**: Returns `{ error: { code: 429|503|..., status: "RESOURCE_EXHAUSTED"|"UNAVAILABLE", errors: [...] } }`. Status `RESOURCE_EXHAUSTED` (429) = quota. Status `UNAVAILABLE` (503) = capacity.

### Consumers
- `provisionNode()` in `apps/api/src/services/nodes.ts` calls `provider.createVM()` — catches all errors and sets node `status: 'error'`. No retry at this level — retry is inside the provider.

## Implementation Checklist

### Phase 1: Normalized Error Category on ProviderError
- [ ] Add `category` field to `ProviderError`: `'transient_capacity' | 'quota_exceeded' | 'invalid_config' | 'rate_limited' | 'auth_error' | 'unknown'`
- [ ] Add `providerCode` field to `ProviderError`: captures the raw provider error code string (e.g., `"resource_unavailable"`)
- [ ] Update `providerFetch()` to extract `error.code` from JSON responses and pass it through to ProviderError
- [ ] Export the `ProviderErrorCategory` type from index.ts

### Phase 2: Per-Provider Error Classification
- [ ] Add `classifyHetznerError(statusCode, providerCode, message)` in `hetzner.ts` — maps Hetzner error codes to normalized categories. Primary signal: `error.code` field. Fallback: existing message regex patterns.
- [ ] Add `classifyScalewayError(statusCode, providerCode, message)` in `scaleway.ts` — maps Scaleway error types
- [ ] Add `classifyGcpError(statusCode, providerCode, message)` in `gcp.ts` — maps GCP error statuses
- [ ] Refactor `isTransientCapacityError()` to use `error.category === 'transient_capacity'` instead of message regex

### Phase 3: Time-Bounded Retry Window
- [ ] Replace attempt-count-based retry with time-bounded retry window in `HetznerProvider.createVM()`
- [ ] Default budget: ~5 minutes (`CAPACITY_RETRY_BUDGET_MS`, default 300_000)
- [ ] Default initial interval: 30s (`CAPACITY_RETRY_INITIAL_DELAY_MS`, existing knob generalized)
- [ ] Default max interval: 120s (existing `CAPACITY_RETRY_MAX_DELAY_MS`)
- [ ] Default max attempts kept as safety valve (existing `CAPACITY_RETRY_MAX_ATTEMPTS`, increase default to 10)
- [ ] All knobs configurable via provider config (constitution Principle XI)
- [ ] Retry ONLY `transient_capacity` category — all other categories fail fast

### Phase 4: Tests
- [ ] Test: `transient_capacity` → retried within window, succeeds on later attempt
- [ ] Test: `transient_capacity` → exhausts window → fails with clear error
- [ ] Test: `quota_exceeded` / `invalid_config` → NOT retried (fails fast)
- [ ] Test: Hetzner `"unsupported location for server type"` 422 with code `resource_unavailable` → mapped to `transient_capacity` → IS retried
- [ ] Test: Hetzner `"unsupported location for server type"` 422 WITHOUT code → fallback message match attempted
- [ ] Test: Per-provider classification mapping (Hetzner, Scaleway, GCP)
- [ ] Test: Config knobs control behavior (custom budget, custom interval)
- [ ] Test: `providerFetch` extracts and threads `error.code` through to ProviderError

### Phase 5: Backlog for related issue
- [ ] File backlog task for failed-provisioning node cleanup (error/stale nodes not auto-reaped)

## Acceptance Criteria
- [ ] ProviderError carries a normalized `category` field
- [ ] ProviderError carries the raw `providerCode` from the provider
- [ ] Hetzner 422 with code `resource_unavailable` is classified as `transient_capacity` and retried
- [ ] Retry uses a time-bounded window (~5 min default) instead of just attempt count
- [ ] Non-capacity errors (`quota_exceeded`, `invalid_config`) fail fast with no retry
- [ ] All retry thresholds are configurable via provider config
- [ ] Scaleway and GCP providers have classification functions
- [ ] Behavioral tests prove all classification and retry paths
- [ ] No hardcoded values (constitution Principle XI)
