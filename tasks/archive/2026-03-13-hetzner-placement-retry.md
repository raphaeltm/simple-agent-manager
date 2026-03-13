# Hetzner 412 Placement Retry

## Problem

When Hetzner returns HTTP 412 "error during placement" (datacenter at capacity), VM provisioning fails immediately with no retry. This causes task execution to fail even when other Hetzner regions have available capacity.

## Research Findings

- **Error source**: Hetzner API returns 412 when a specific datacenter cannot place a server
- **Affected code**: `packages/providers/src/hetzner.ts` — `HetznerProvider.createVM()`
- **Error handling**: `providerFetch` wraps HTTP errors as `ProviderError` with `statusCode`
- **Available locations**: `fsn1`, `nbg1`, `hel1`, `ash`, `hil`
- **Caller**: `apps/api/src/services/nodes.ts:provisionNode()` — catches errors and sets node status to `error`

## Implementation

- [x] Add `PLACEMENT_RETRY_DELAY_MS` constant (3s)
- [x] Modify `createVM()` to retry same location after 3s delay on 412
- [x] Fall back to shuffled remaining locations if primary retry also 412s
- [x] Non-412 errors (auth, quota) remain non-retryable
- [x] Add test: retry same location after delay succeeds
- [x] Add test: fallback to other locations after primary retry fails
- [x] Add test: all locations exhausted throws ProviderError
- [x] Add test: non-412 errors not retried
- [x] Add test: primary location tried first on success
- [x] All tests pass, build clean

## Acceptance Criteria

- [x] 412 in primary location retries same location after 3s
- [x] If retry fails, tries remaining locations (shuffled)
- [x] Non-placement errors fail immediately
- [x] Logs indicate which location failed and which succeeded
- [x] 64 provider tests pass
