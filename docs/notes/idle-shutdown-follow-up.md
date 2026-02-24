# Idle Shutdown Follow-Up

Date: 2026-02-11 (original), 2026-02-24 (cleanup completed)
Scope: `specs/014-multi-workspace-nodes`

## Status: Infrastructure Removed

All idle timeout infrastructure has been removed from the codebase as of 2026-02-24. The feature was unreliable and has been fully cleaned up rather than left as dead code.

### What Was Removed

- **VM Agent**: `internal/idle/` package (detector, shutdown stub, all tests)
- **VM Agent config**: `IdleTimeout`, `IdleCheckInterval` env vars
- **API**: Heartbeat endpoint (`POST /workspaces/:id/heartbeat`), idle timeout validation, `getIdleTimeoutSeconds()` helpers
- **Database**: `shutdown_deadline` and `idle_timeout_seconds` columns (D1 migration 0016)
- **Shared types**: `HeartbeatRequest`, `HeartbeatResponse`, `shutdownDeadline`, `idleTimeoutSeconds` from interfaces; `DEFAULT_IDLE_TIMEOUT_SECONDS`, `DEFAULT_IDLE_WARNING_SECONDS`, `DEFAULT_TASK_RUN_WORKSPACE_IDLE_TIMEOUT_SECONDS` from constants
- **Terminal**: `useIdleDeadline` hook, deadline display in StatusBar
- **Web UI**: Shutdown countdown in sidebar, idle timeout in workspace creation
- **Cloud-init**: `IDLE_TIMEOUT` environment variable from systemd unit
- **E2E scripts**: Heartbeat mock endpoints

### What Was Kept

- **PTY session idle tracking** (`IdleTime()`, `CleanupIdleSessions()`): Used for individual terminal session management, unrelated to workspace-level shutdown.
- **ACP `HostIdle` status**: Agent session state, unrelated to workspace idle shutdown.
- **HTTP `IdleTimeout`**: Standard Go HTTP server setting for connection management.
- **`lastActivityAt` column**: Useful for future stale-workspace detection or admin visibility.

## Future Considerations

If idle shutdown is revisited in the future, it should be designed fresh with:
- Clear policy for Node-level vs Workspace-level idle detection
- Feature flag with staged rollout
- End-to-end tests covering reconnect, long-running jobs, and multi-workspace workloads
- Telemetry for false-positive shutdowns
