# Browser Sidecar Go Concurrency and Resource Management Fixes

**Created**: 2026-03-31
**Source**: Go specialist review of Neko Browser Streaming Sidecar (PR #568, completed post-merge)

## Problem

The browser sidecar Manager holds the write mutex across Docker CLI calls (which can take seconds), blocking all concurrent operations. Additional issues include orphaned container recovery, removeForwarder state consistency, and missing IPv6 port detection.

## Acceptance Criteria

### Critical — Mutex held during I/O
- [ ] Refactor `syncForwarders` in `socat.go` to copy state under a short read lock, perform Docker I/O without any lock, then re-acquire write lock to apply the diff
- [ ] Refactor `Start` in `manager.go` to set `StatusStarting` under the lock, release it, run Docker commands unlocked, then re-acquire to set `StatusRunning`/`StatusError`

### High — Orphaned containers
- [ ] Add orphaned container recovery on Manager startup: enumerate `docker ps --filter name=neko-` and remove stale containers from prior agent runs (needed because `--restart unless-stopped` policy means containers survive agent restart)
- [ ] Add deferred cleanup in `Start` so the container is removed if any step after `docker run` fails
- [ ] Update early-return guard in `Start` to handle `StatusStarting` and `StatusError` states (prevent duplicate container creation)

### High — resolveContainerID empty string
- [ ] Return explicit error from `resolveContainerID` when container ID cannot be resolved, instead of returning `("", nil)`

### Medium — removeForwarder state consistency
- [ ] On `removeForwarder` failure in `syncForwarders`, keep the forwarder in `remaining` (don't remove from state) to avoid duplicate socat processes on next sync tick

### Medium — IPv6 port detection
- [ ] Read `/proc/net/tcp6` in addition to `/proc/net/tcp` in `detectContainerPorts` to detect IPv6-only services

### Medium — Context handling in cleanup
- [ ] Use `context.Background()` with timeout for `browserManager.Stop()` calls in `handleStopWorkspace` and `handleDeleteWorkspace` (matches pattern used by `removeWorkspaceContainer` and `bootstrap.RemoveVolume`)

### Low
- [ ] Rename `NekoWebRTCPort`/`NEKO_WEBRTC_PORT` to `NekoHTTPPort`/`NEKO_HTTP_PORT` (port 8080 is Neko's HTTP/WebSocket port, not WebRTC media)
- [ ] Remove or wire `buildViewportChromeFlags` dead code in `container.go`

## References
- Manager: `packages/vm-agent/internal/browser/manager.go`
- Socat: `packages/vm-agent/internal/browser/socat.go`
- Container: `packages/vm-agent/internal/browser/container.go`
- Handlers: `packages/vm-agent/internal/server/browser_handlers.go`
