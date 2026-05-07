# Enable Go Race Detector in CI

## Problem

The VM agent Go tests run in CI without `-race`, so data races go undetected. The 2026-05-07 evaluation (P2-03) identified this gap in testing foundation.

## Research Findings

### Current CI Go test commands (`.github/workflows/ci.yml`)
- `vm-agent-test` (line 300): `go test ./...` — no `-race`
- `vm-agent-integration` (line 331): `go test -v -tags integration -timeout 15m ./internal/bootstrap/ ./internal/acp/` — no `-race`
- `vm-agent-e2e` (line 358): `go test -v -tags e2e -timeout 15m ./internal/e2e/` — no `-race`

### Makefile (`packages/vm-agent/Makefile`)
- `test` target: `go test -v ./...` — no `-race`

### Races found locally with `go test -race ./...`
1. **`internal/pty` — `RingBuffer.Len()`**: Called without holding `rb.mu`. `Write()` and `ReadAll()` lock, but `Len()` does not. Race between `Write` goroutine and `Len()/ReadAll()` reader goroutine in `TestRingBuffer_ConcurrentWriteRead`.
2. **`internal/server` — heartbeat test variables**: `TestHeartbeatRetriesPendingReadyCallback` uses bare `readyCalled bool` and `heartbeatCount int` written in HTTP handler goroutine, read in test goroutine. `TestHeartbeatRetryUsesNodeTokenWhenWorkspaceHasNone` uses bare `receivedAuth string` the same way.

All other packages pass with `-race` (16 packages clean).

## Implementation Checklist

- [x] Fix `RingBuffer.Len()` to acquire mutex (production code fix)
- [x] Fix `TestHeartbeatRetriesPendingReadyCallback` to use atomic/mutex for `readyCalled` and `heartbeatCount`
- [x] Fix `TestHeartbeatRetryUsesNodeTokenWhenWorkspaceHasNone` to use atomic/mutex for `receivedAuth`
- [x] Add `-race` to CI `vm-agent-test` job
- [x] Add `-race` to CI `vm-agent-integration` job
- [x] Add `-race` to CI `vm-agent-e2e` job
- [x] Add `-race` to Makefile `test` target
- [x] Verify `go test -race ./...` passes locally with all fixes

## Acceptance Criteria

- [x] `go test -race ./...` passes with zero race warnings in `packages/vm-agent/`
- [x] CI workflow uses `-race` for all three Go test jobs
- [x] Makefile `test` target uses `-race`
- [x] No unrelated refactors

## References

- `.github/workflows/ci.yml` lines 283-358
- `packages/vm-agent/Makefile`
- `packages/vm-agent/internal/pty/ring_buffer.go` (Len method, line 89)
- `packages/vm-agent/internal/server/health_test.go` (heartbeat tests)
