# VM Agent Process Lifecycle & Long-Running Stability

**Created**: 2026-02-24
**Priority**: High
**Classification**: `cross-component-change`, `business-logic-change`, `infra-change`

## Background

Production logs from node `01KJ6BHZ54NHE6EZ8J24MPCXSC` on 2026-02-24 revealed multiple interrelated issues that together indicate a **resource management problem** in the VM agent's process lifecycle. The node had been running for approximately 24 hours before critical failures began.

The observed failure sequence:
1. **03:59** — Client disconnected after ~37 min idle (client-side, not a bug)
2. **07:30** — Superfluous `WriteHeader` warnings during session reconnection
3. **07:30–07:32** — Rapid viewer attach/detach churn (~6 cycles in 110 seconds)
4. **07:39** — SIGTERM shutdown initiated
5. **07:41** — `docker` process (PID 18643) hung, systemd SIGTERM timed out after 90s, SIGKILL sent, cgroup kill failed with "Invalid argument"
6. **07:41** — Post-restart DNS resolution failures (systemd-resolved at 127.0.0.53 refused connections)
7. **07:45** — Stale PTY sessions produced I/O errors on restart

Additionally: the user was unable to connect new agents to a *different* workspace on the same node at ~07:40, suggesting Docker daemon resource exhaustion. The user also reports that over time, opening and closing chat sessions leads to a growing list of ACP processes that require manual cleanup.

### Design Constraint: ACP Sessions Must Be Long-Lived

**ACP sessions MUST persist even when no viewer is connected.** This is a core value proposition: users should be able to close their laptop, go offline, and return later to find their agent sessions exactly as they left them — still running, context intact. Background execution is not optional.

The conversation context inside an ACP session is irreplaceable. Claude Code's `.jsonl` conversation files don't currently provide a reliable mechanism to reconstruct session context after the process is killed. If we terminate an ACP session, the user loses that conversation and all its accumulated context. This means:

1. **Session lifetime must be user-controlled** — only the user (or workspace stop/delete) should kill a session
2. **Auto-killing idle sessions is NOT acceptable** — an "idle" agent may be between user prompts, and the context it holds is valuable
3. **The resource problem must be solved without sacrificing session persistence** — we need to make sessions cheaper, give users better management tools, and clean up only truly dead (crashed) processes

### What Already Works

The system already has partial orphan detection and recovery:
- `listAgentSessionsLive()` enriches sessions with `hostStatus` and `viewerCount` from the running SessionHost
- `isOrphanedSession()` identifies sessions alive on the VM but marked stopped in the DB
- `OrphanedSessionsBanner` shows recovered sessions and offers a "Stop All" action
- `resumeAgentSession()` syncs DB status when an orphaned session is detected
- Tab persistence in SQLite preserves `acp_session_id` for reconnection via `LoadSession`

### What's Missing

Despite the existing orphan recovery, users still accumulate invisible resource burden:
- **No resource visibility**: Users can't see how many processes are running, how much memory they're consuming, or how close the node is to capacity
- **No proactive session management**: The only way to stop sessions is one-by-one in the sidebar or via the orphaned sessions banner (which auto-dismisses after 15 seconds)
- **No concurrent session limits**: Nothing prevents a user from creating 50 simultaneous agent sessions, each running a `docker exec` process
- **Crashed processes aren't cleaned up**: If an agent process crashes (non-zero exit after startup), the SessionHost stays in the map in `error` state with resources still partially allocated
- **Process management deficiencies**: `docker exec` processes aren't managed as process groups, making kill unreliable; no graceful stop sequence; goroutines leak from PTY readers

## Root Cause Analysis

### Primary Issue: Accumulated Process Resources Without User-Facing Limits

Over 24 hours of use, each chat session creates a `docker exec` agent process that (correctly) survives viewer disconnection. The resource cost per session:
- A `docker exec` CLI process on the host
- A corresponding process inside the container (the ACP agent itself)
- Stdin/stdout/stderr pipe file descriptors
- A `monitorProcessExit` goroutine
- A `monitorStderr` goroutine
- A message buffer (up to 5000 messages × ~1KB each ≈ 5MB per session)

With no per-node session limits and no user tools for bulk session management, dozens of processes accumulate. Eventually the Docker daemon becomes resource-exhausted (too many concurrent exec sessions), cascading into:
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

### Phase 1: Session Resource Visibility & Management (Critical)

Give users visibility into their running sessions and tools to manage them efficiently. Clean up only truly dead (crashed) sessions automatically.

**1a. Resource visibility in the UI**

Expose per-session resource information so users can make informed decisions about which sessions to keep and which to stop.

- Add resource summary to the workspace sidebar/header: "N sessions running" with expandable detail
- Show session age (how long since creation) and last activity time in the session list
- Show whether an agent is actively prompting vs idle-since-last-prompt
- Add a "Manage Sessions" panel or modal that lists ALL sessions with their status, age, and activity — not just the current tab's session

**1b. Bulk session management**

- Add "Stop All Idle Sessions" action (stops sessions that are in `ready`/`idle` state and haven't had activity for a user-chosen threshold)
- Add multi-select in the sessions list for bulk stop operations
- Make the `OrphanedSessionsBanner` persistent (not auto-dismiss after 15s) when there are orphaned sessions — or move orphan recovery into the session management panel
- Add a confirmation dialog when stopping sessions that explains context will be lost

**1c. Automatic cleanup of CRASHED sessions only**

Crashed sessions (where the agent process exited abnormally and couldn't be restarted) should be cleaned up automatically since they're already non-functional. Currently, the SessionHost stays in the map in `error` state after max restart attempts are exceeded (`session_host.go:695-710`).

- When `monitorProcessExit` gives up on restart (exceeds `maxRestarts`), schedule cleanup of the SessionHost's remaining resources (goroutines, buffers, map entry) after broadcasting the error to viewers
- Leave the agent session record in the DB (marked as `error`) so the UI can show it — just release the server-side resources
- Similarly, if the ACP `Initialize` or `NewSession` handshake fails, clean up the SessionHost resources immediately rather than leaving a half-initialized host in the map

**1d. Per-node concurrent session limits**

- Add a configurable max concurrent active sessions per workspace (e.g., `MAX_CONCURRENT_AGENT_SESSIONS`, default 10)
- When the limit is reached, new session creation returns an error with a message like "Maximum concurrent sessions reached. Stop unused sessions to create new ones."
- Expose the current/max count in the `/health` endpoint and the session management UI

**Affected files:**
| File | Change |
|------|--------|
| `apps/web/src/components/WorkspaceSidebar.tsx` | Session resource visibility, bulk management |
| `apps/web/src/pages/Workspace.tsx` | Session management panel/modal |
| `apps/web/src/lib/session-utils.ts` | Session age/activity helpers |
| `packages/vm-agent/internal/acp/session_host.go` | Resource cleanup for crashed sessions |
| `packages/vm-agent/internal/server/agent_ws.go` | Concurrent session limit check |
| `packages/vm-agent/internal/config/config.go` | `MAX_CONCURRENT_AGENT_SESSIONS` env var |

### Phase 2: Process Group Management

Ensure `docker exec` processes and their children are properly killed as a group. This makes `Stop()` reliable and prevents zombie processes.

**Key changes:**
- Set `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` in `StartProcess()` so the docker exec process gets its own process group
- In `Stop()`, implement a graceful stop sequence: close stdin → SIGTERM to process group → wait with timeout (5s) → SIGKILL to process group → wait
- Add a context-based timeout to `Stop()` (e.g., 10 seconds total) so it doesn't block indefinitely

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

Fix goroutine leaks and enable orphan cleanup for terminal sessions (these ARE safe to auto-cleanup since terminal sessions are stateless — unlike ACP sessions, there's no irreplaceable context).

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
- In `handleAgentWS()`, after `upgrader.Upgrade()` fails, do not call any additional write functions on the ResponseWriter (gorilla/websocket already writes the error response)
- Add a `responseWriterWrapper` that tracks whether `WriteHeader` has been called and silently drops duplicate calls (defensive, since the root cause should be fixed by the above)

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
- Add SessionHost count (total, by-status, with-viewers, without-viewers) to `/health`
- Add `docker exec` process count to `/health` or `/system-info`
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
- Crashed SessionHost resource cleanup after max restart failures
- Concurrent session limit enforcement
- Process group kill with Setpgid and graceful stop timeout
- Retry logic for JWK fetch (mock HTTP server with transient failures)
- PTY output reader exits cleanly on context cancellation

### Integration Tests
- Full lifecycle: create 10+ sessions → verify all running → stop via bulk action → verify cleanup
- Concurrent limit: create sessions up to limit → verify next creation fails with clear error
- Crash cleanup: start session → kill agent process → verify resources cleaned up, session marked error
- Shutdown: start sessions → SIGTERM → verify all processes cleaned up within timeout
- Restart resilience: start agent → simulate DNS failure → verify retry succeeds

### Manual Verification
- Deploy to staging, open/close 10+ chat sessions over 1 hour
- Verify `docker exec` process count stays bounded
- Verify `/health` endpoint shows correct session counts
- Verify session management UI shows all sessions with resource info
- Force-restart the service and verify clean recovery
- Stop workspace and verify all sessions stopped

## Acceptance Criteria

- [ ] Users can see all running sessions with age, activity time, and status
- [ ] Users can bulk-stop sessions (e.g., "stop all idle" or multi-select)
- [ ] Crashed/errored SessionHosts auto-release server-side resources
- [ ] Per-workspace concurrent session limit enforced with clear user error message
- [ ] `docker exec` processes use process groups and are reliably killed on Stop()
- [ ] Systemd service definition includes TimeoutStopSec, KillMode, and SuccessExitStatus
- [ ] JWK fetch and ready callback retry with exponential backoff on startup
- [ ] PTY output reader goroutines are context-cancellable and tracked via WaitGroup
- [ ] Superfluous WriteHeader warnings eliminated
- [ ] `/health` endpoint reports goroutine count, SessionHost count, and process count
- [ ] No Docker daemon exhaustion after 24+ hours of normal use (verified in staging)
- [ ] All existing tests continue to pass
- [ ] New unit and integration tests added for all changed behavior

## Non-Goals (Explicit)

- **Auto-killing idle ACP sessions** — Session lifetime is user-controlled. An idle session holds irreplaceable conversation context.
- **Auto-killing sessions on viewer disconnect** — Background execution is a core value prop. Users close laptops and return later.
- **Time-based session expiry** — Until we have a mechanism to persist and restore full ACP session context independently of the running process, sessions must remain alive as long as the user hasn't stopped them.

## Future Considerations

When Claude Code or the ACP protocol supports reliable session serialization/deserialization (saving full conversation context to disk and restoring it later in a new process), we could:
- Allow sessions to be "suspended" (process stopped, context saved) and "resumed" (new process, context restored)
- Implement cost-based scheduling: suspend least-recently-used sessions when approaching resource limits
- Enable session migration between nodes

Until then, a running process is the ONLY way to preserve session context.

## Dependencies

None — all changes are internal to the vm-agent package, cloud-init template, and web app.

## Risk Assessment

- **Phase 1** (visibility + limits) is the highest-impact change and carries moderate risk. The session limit must be generous enough for power users. Session management UI must be intuitive and not disruptive.
- **Phase 2** (process groups) changes signal delivery semantics. Must be tested on Linux (Hetzner VMs) to ensure `Setpgid` works correctly inside the systemd service context.
- **Phase 3** (systemd) changes deployment behavior. Requires testing the full shutdown → restart cycle on a real VM.
- **Phase 4** (retry) is low risk but must ensure the retry loop doesn't mask permanent failures (e.g., wrong JWKS URL).
- **Phase 5** (PTY cleanup) is safe since terminal sessions are stateless — orphan cleanup is appropriate here, unlike for ACP sessions.
