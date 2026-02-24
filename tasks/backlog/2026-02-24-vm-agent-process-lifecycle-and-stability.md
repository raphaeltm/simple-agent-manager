# VM Agent Process Lifecycle & Long-Running Stability

**Created**: 2026-02-24
**Priority**: High
**Classification**: `cross-component-change`, `business-logic-change`, `infra-change`

## Background

Production logs from node `01KJ6BHZ54NHE6EZ8J24MPCXSC` on 2026-02-24 revealed multiple interrelated issues that together indicate a **resource leak pattern** in the VM agent's process lifecycle management. The node had been running for approximately 24 hours before critical failures began.

The observed failure sequence:
1. **03:59** — Client disconnected after ~37 min idle (client-side, not a bug)
2. **07:30** — Superfluous `WriteHeader` warnings during session reconnection
3. **07:30–07:32** — Rapid viewer attach/detach churn (~6 cycles in 110 seconds)
4. **07:39** — SIGTERM shutdown initiated
5. **07:41** — `docker` process (PID 18643) hung, systemd SIGTERM timed out after 90s, SIGKILL sent, cgroup kill failed with "Invalid argument"
6. **07:41** — Post-restart DNS resolution failures (systemd-resolved at 127.0.0.53 refused connections)
7. **07:45** — Stale PTY sessions produced I/O errors on restart

Additionally: the user was unable to connect new agents to a *different* workspace on the same node at ~07:40, suggesting Docker daemon resource exhaustion. The user also reports that over time, opening and closing chat sessions leads to a growing list of orphaned ACP processes that require manual cleanup.

## Root Cause Analysis

### Primary Issue: Unbounded ACP Process Accumulation

The VM agent's SessionHost lifecycle has a critical gap: **SessionHosts and their owned `docker exec` agent processes are never automatically cleaned up when all viewers disconnect.**

The code flow:
1. `handleAgentWS()` → `getOrCreateSessionHost()` creates a SessionHost stored in `s.sessionHosts[workspaceID:sessionID]` (`agent_ws.go:110-160`)
2. SessionHost spawns a `docker exec -i` process via `StartProcess()` (`process.go:95-140`)
3. When a viewer's WebSocket closes, `host.DetachViewer(viewerID)` removes the viewer but explicitly does NOT stop the agent (`session_host.go:285-295`)
4. SessionHosts are only stopped by explicit API calls (`stopSessionHost()`), workspace stop/delete, or node shutdown

**This means every chat session the user opens creates an agent process that survives indefinitely**, even after the user navigates away. Over 24 hours of normal use, dozens of `docker exec` processes accumulate, each holding:
- A `docker exec` CLI process on the host
- A corresponding process inside the container
- Stdin/stdout/stderr pipe file descriptors
- A `monitorProcessExit` goroutine
- A `monitorStderr` goroutine
- A message buffer (up to 5000 messages × ~1KB each ≈ 5MB per session)

Eventually, the Docker daemon becomes resource-exhausted (too many concurrent exec sessions), which cascades into:
- New agent processes can't start (user can't connect agents)
- `docker exec` processes become unresponsive to kill signals
- Service shutdown hangs waiting for docker processes to die
- systemd resorts to SIGKILL and cgroup kill

### Secondary Issues

**No systemd `TimeoutStopSec`**: The cloud-init systemd service definition (`packages/cloud-init/src/template.ts:36-50`) lacks `TimeoutStopSec`, `KillMode`, and `SuccessExitStatus` directives. The default 90s `TimeoutStopSec` is too long for a service managing Docker processes.

**No JWK/ready callback retry**: On restart, `auth.NewJWTValidator()` makes a single attempt to fetch JWKS with a 10s timeout (`auth/jwt.go:29-36`). The node ready callback similarly has no retry logic. If DNS is briefly unavailable after a forced restart, both fail permanently.

**PTY orphan cleanup disabled**: The cloud-init template sets `IDLE_TIMEOUT=0s`, and `PTYOrphanGracePeriod` defaults to 0 (disabled) when not explicitly configured. Orphaned PTY sessions log "Session orphaned, automatic cleanup disabled" and persist in memory indefinitely (`pty/manager.go:258-264`).

**PTY output reader goroutine leak**: `StartOutputReader()` spawns a goroutine with an infinite `for` loop reading from `s.Pty.Read(buf)` (`pty/session.go:177-211`). There is no `context.Context` or cancellation channel — the goroutine only exits when the PTY read returns an error. During shutdown, if the PTY file descriptor isn't closed quickly enough, these goroutines leak.

**Superfluous WriteHeader**: The `writeJSON` function at `routes.go:182` is called on ResponseWriters that have already had headers written, likely during WebSocket upgrade error paths where gorilla/websocket's `Upgrade()` already writes an error response before the handler's error-writing code runs.

## Proposed Solution

### Phase 1: SessionHost Orphan Lifecycle (Critical)

Add automatic cleanup of SessionHosts when all viewers disconnect, mirroring the existing PTY orphan pattern.

**Key changes:**
- Add `OrphanSessionHost()` / `ReattachSessionHost()` methods to track viewer-less hosts
- Start a configurable grace timer when last viewer detaches (e.g., `ACP_ORPHAN_GRACE_PERIOD`, default 10 minutes)
- On grace period expiry: stop the agent process, remove from `sessionHosts` map, clean up all resources
- Cancel the timer if a viewer reattaches within the grace period
- Add a periodic audit goroutine (every 60s) that checks for leaked SessionHosts as a safety net
- Expose orphaned session count in the `/health` endpoint for monitoring

**Affected files:**
| File | Change |
|------|--------|
| `packages/vm-agent/internal/acp/session_host.go` | Add orphan state tracking, grace timer, cleanup |
| `packages/vm-agent/internal/server/agent_ws.go` | Call OrphanSessionHost when last viewer detaches |
| `packages/vm-agent/internal/server/server.go` | Add periodic orphan audit goroutine, health endpoint data |
| `packages/vm-agent/internal/config/config.go` | Add `ACPOrphanGracePeriod` env var |

### Phase 2: Process Group Management

Ensure `docker exec` processes and their children are properly killed as a group.

**Key changes:**
- Set `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` in `StartProcess()` so the docker exec process gets its own process group
- In `Stop()`, send SIGTERM to the process group first (`syscall.Kill(-pgid, syscall.SIGTERM)`), wait with timeout, then SIGKILL the group
- Add a context-based timeout to `Stop()` (e.g., 10 seconds) so it doesn't block indefinitely

**Affected files:**
| File | Change |
|------|--------|
| `packages/vm-agent/internal/acp/process.go` | Process group setup, graceful stop with timeout |

**Best practices reference:**
- [Go process group management](https://www.stormkit.io/blog/hunting-zombie-processes-in-go-and-docker) — Use `Setpgid: true` and negative PGID kill
- [Docker zombie process handling](https://academy.fpblock.com/blog/2016/10/docker-demons-pid1-orphans-zombies-signals/) — PID 1 adoption and reaping

### Phase 3: Systemd Service Hardening

Improve the systemd service definition for robust shutdown and restart.

**Key changes:**
```ini
[Service]
TimeoutStopSec=45
KillMode=mixed
SuccessExitStatus=143
RestartSec=5
Restart=always
StartLimitIntervalSec=300
StartLimitBurst=5
```

- `TimeoutStopSec=45` — Give the agent 45s for graceful shutdown before SIGKILL
- `KillMode=mixed` — SIGTERM to main process, SIGKILL remaining cgroup processes
- `SuccessExitStatus=143` — Treat SIGTERM exit (128+15=143) as success
- `StartLimitBurst=5` in 300s — Prevent restart loops on persistent failures

**Affected files:**
| File | Change |
|------|--------|
| `packages/cloud-init/src/template.ts` | Update systemd unit definition |

**Best practices reference:**
- [systemd service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) — Official reference for TimeoutStopSec, KillMode
- [systemd KillMode and graceful shutdown](https://ihaveabackup.net/2022/01/30/systemd-killmodes-multithreading-and-graceful-shutdown/) — Mixed mode for multi-process services

### Phase 4: Startup Resilience (JWK + Ready Callback Retry)

Add retry with exponential backoff for network-dependent startup operations.

**Key changes:**
- Wrap JWK fetch in a retry loop: initial 2s delay, exponential backoff to 30s, max 5 attempts
- Wrap node ready callback in a retry loop: same parameters
- Add DNS readiness check (resolve the API hostname) before attempting either
- Log each retry attempt at WARN level

**Affected files:**
| File | Change |
|------|--------|
| `packages/vm-agent/internal/auth/jwt.go` | Retry loop for JWKS fetch |
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | Retry loop for ready callback |
| `packages/vm-agent/main.go` | Optional DNS readiness check |

**Best practices reference:**
- [systemd-resolved DNS failures](https://github.com/systemd/systemd/issues/21123) — Known issue where resolved stops resolving silently
- [Docker DNS with systemd-resolved](https://pedro.tec.br/fixing-docker-dns-resolution-issues-with-systemd-resolved-on-linux/) — Configuring fallback DNS

### Phase 5: PTY Lifecycle Improvements

Fix goroutine leaks and enable orphan cleanup.

**Key changes:**
- Pass `context.Context` to `StartOutputReader()` and select on `ctx.Done()` alongside the PTY read
- Set a reasonable default `PTY_ORPHAN_GRACE_PERIOD` (e.g., 5 minutes) instead of disabled
- Use `sync.WaitGroup` to track output reader goroutines so `CloseAllSessions()` can wait for them
- In `Close()`, ensure PTY file descriptor is closed BEFORE killing the process (closing the fd unblocks the reader goroutine)

**Affected files:**
| File | Change |
|------|--------|
| `packages/vm-agent/internal/pty/session.go` | Context-aware output reader, WaitGroup |
| `packages/vm-agent/internal/pty/manager.go` | Default grace period, WaitGroup tracking |
| `packages/vm-agent/internal/config/config.go` | Default for `PTY_ORPHAN_GRACE_PERIOD` |

**Best practices reference:**
- [Go goroutine leak prevention](https://dev.to/serifcolakel/go-concurrency-mastery-preventing-goroutine-leaks-with-context-timeout-cancellation-best-1lg0) — Context-based cancellation patterns
- [creack/pty cleanup](https://github.com/creack/pty) — Known issue: io.Copy goroutine blocks until next keystroke; close the fd to unblock
- [uber-go/goleak](https://github.com/uber-go/goleak) — Use in tests to detect goroutine leaks

### Phase 6: Superfluous WriteHeader Fix

Prevent double header writes on WebSocket error paths.

**Key changes:**
- Use a `responseWriterWrapper` that tracks whether `WriteHeader` has been called
- In `handleAgentWS()`, after `upgrader.Upgrade()` fails, do not call any additional write functions on the ResponseWriter (gorilla/websocket already writes the error)
- Alternatively, check `Upgrade()` error and return immediately, since the library handles the HTTP error response

**Affected files:**
| File | Change |
|------|--------|
| `packages/vm-agent/internal/server/routes.go` | Add written guard to writeJSON, or wrapper |
| `packages/vm-agent/internal/server/agent_ws.go` | Remove redundant error writes after upgrade failure |

**Best practices reference:**
- [Understanding superfluous WriteHeader](https://zerotohero.dev/go/go-http-headers/) — Single responsibility for response writing
- [gorilla/websocket upgrade](https://pkg.go.dev/github.com/gorilla/websocket) — Upgrade() writes its own error responses

### Phase 7: Observability Improvements

Add monitoring to detect resource accumulation before it becomes critical.

**Key changes:**
- Add goroutine count to `/health` endpoint (`runtime.NumGoroutine()`)
- Add SessionHost count (total, orphaned, with-viewers) to `/health`
- Add docker exec process count to `/health` or `/system-info`
- Log resource counts periodically (every 5 minutes) at INFO level
- Consider exposing a `/debug/pprof` endpoint (behind management auth) for production profiling

**Affected files:**
| File | Change |
|------|--------|
| `packages/vm-agent/internal/server/routes.go` | Enrich health endpoint |
| `packages/vm-agent/internal/server/server.go` | Periodic resource logging goroutine |

**Best practices reference:**
- [Go pprof in production](https://dev.to/davidsbond/golang-debugging-memory-leaks-using-pprof-5di8) — Expose pprof endpoints for on-demand profiling
- [50,000 goroutine leak debugging](https://skoredin.pro/blog/golang/goroutine-leak-debugging) — Monitor goroutine count, compare profiles over time

## Testing Strategy

### Unit Tests
- SessionHost orphan lifecycle: attach → detach → grace timer → cleanup
- SessionHost reattach within grace period cancels timer
- Process group kill with Setpgid
- Retry logic for JWK fetch (mock HTTP server with transient failures)
- PTY output reader exits cleanly on context cancellation

### Integration Tests
- Full lifecycle: create session → attach viewer → detach viewer → wait for grace period → verify process cleaned up
- Multiple viewers: attach 2 viewers → detach 1 → verify host stays alive → detach 2nd → verify cleanup
- Shutdown: start sessions → SIGTERM → verify all processes cleaned up within timeout
- Restart resilience: start agent → simulate DNS failure → verify retry succeeds

### Manual Verification
- Deploy to staging, open/close 10+ chat sessions over 1 hour
- Verify `docker exec` process count does not grow unbounded
- Verify `/health` endpoint shows correct orphan counts
- Force-restart the service and verify clean recovery

## Acceptance Criteria

- [ ] SessionHosts are automatically cleaned up after configurable grace period when all viewers disconnect
- [ ] `docker exec` processes use process groups and are reliably killed on Stop()
- [ ] Systemd service definition includes TimeoutStopSec, KillMode, and SuccessExitStatus
- [ ] JWK fetch and ready callback retry with exponential backoff on startup
- [ ] PTY output reader goroutines are context-cancellable and tracked via WaitGroup
- [ ] Superfluous WriteHeader warnings eliminated
- [ ] `/health` endpoint reports goroutine count, SessionHost count, and orphan count
- [ ] No resource accumulation after 24+ hours of normal use (verified in staging)
- [ ] All existing tests continue to pass
- [ ] New unit and integration tests added for all changed behavior

## Dependencies

None — all changes are internal to the vm-agent package and cloud-init template.

## Risk Assessment

- **Phase 1** (SessionHost orphan cleanup) is the highest-impact change and carries the most risk. The grace period must be long enough that brief disconnects (tab switches, network blips) don't kill active agents. 10 minutes is a conservative default.
- **Phase 2** (process groups) changes signal delivery semantics. Must be tested on Linux (Hetzner VMs) to ensure `Setpgid` works correctly inside the systemd service context.
- **Phase 3** (systemd) changes deployment behavior. Requires testing the full shutdown → restart cycle on a real VM.
- **Phase 4** (retry) is low risk but must ensure the retry loop doesn't mask permanent failures (e.g., wrong JWKS URL).
