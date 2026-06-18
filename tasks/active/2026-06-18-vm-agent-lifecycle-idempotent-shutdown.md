# VM Agent Lifecycle Ownership and Idempotent Shutdown

**Created**: 2026-06-18
**Priority**: High
**Idea**: `01KVCX0T7DR7JAGK3AS6HSX9GA`
**Output branch**: `sam/task-implement-sam-idea-01kvcx`

## Human Constraints

- Do not deploy to staging.
- Do not merge the PR.
- Stop at a draft/open PR clearly marked **DO NOT MERGE** and **DO NOT DEPLOY TO STAGING**.
- Do not mark a draft PR ready for review unless the human later explicitly asks.
- Keep the implementation scoped to `packages/vm-agent` lifecycle correctness.
- Do not perform the broader bootstrap step-pipeline refactor in this task.

## Problem

The VM agent owns many long-lived resources: HTTP serving, auth/JWT validation, session managers, ACP session hosts, PTY sessions, port scanners, message reporters, error reporters, persistent stores, event stores, and resource monitors. The current lifecycle contract is implicit, which makes shutdown paths fragile.

The idea and audit context identify these concrete risks:

- `Server.Stop` directly closes `s.done`, so a second call can panic.
- Reporter shutdown methods directly close channels, so repeated or concurrent shutdown can panic.
- ACP session hosts are stopped while `sessionHostMu` is held.
- Some server-owned resources are not clearly closed during server shutdown.
- PTY/session cleanup can happen while broader server locks are held.

## Research Findings

- `packages/vm-agent/internal/server/server.go`
  - `Server.Stop` closes `done` directly, then stops scanners, JWT validator, session hosts, PTY sessions, reporters, persistence store, and HTTP server.
  - `eventStore` and `resourceMonitor` are created by `New` but are not currently closed by `Stop`.
  - `Start` starts health and ACP heartbeat goroutines that exit through `s.done`.
- `packages/vm-agent/internal/server/workspaces.go`
  - `stopSessionHost` and `stopSessionHostsForWorkspace` call `host.Stop()` while holding `sessionHostMu`.
- `packages/vm-agent/internal/server/server.go`
  - `StopAllWorkspacesAndSessions` calls `runtime.PTY.CloseAllSessions()` while holding `workspaceMu`.
- `packages/vm-agent/internal/errorreport/reporter.go`
  - `Shutdown` closes `stopC` directly and waits on `doneC`.
- `packages/vm-agent/internal/messagereport/reporter.go`
  - `Shutdown` closes `stopC` directly and waits on `doneC`.
- `packages/vm-agent/internal/eventstore/store.go`
  - `Close` closes the database directly.
- `packages/vm-agent/internal/resourcemon/monitor.go`
  - `Close` cancels the collection loop, waits on `done`, and closes the database directly.
- `packages/vm-agent/internal/ports/scanner.go`
  - Scanner `Stop` is already idempotent for started scanners.
- The audit files named in the idea were not present at `/engineering/code-elegance-audits/2026-06-18/` or in this checkout. The idea content includes the relevant audit summary and is treated as the source of truth.

## Implementation Checklist

- [x] Make `Server.Stop` idempotent and return the first shutdown result on repeated calls.
- [x] Ensure `Server.Stop` closes/stops server-owned event store and resource monitor.
- [x] Stop ACP session hosts with collect-then-stop semantics outside `sessionHostMu`.
- [x] Remove PTY session cleanup from broad `workspaceMu` critical sections where feasible.
- [x] Make `errorreport.Reporter.Shutdown` idempotent and safe under concurrent callers.
- [x] Make `messagereport.Reporter.Shutdown` idempotent and safe under concurrent callers.
- [x] Add focused tests for `Server.Stop` idempotency and owned resource shutdown.
- [x] Add focused tests for session-host shutdown lock discipline.
- [x] Add reporter idempotency/concurrency tests.
- [x] Run focused Go tests from `packages/vm-agent`.
- [ ] Run `go test ./...` from `packages/vm-agent` if environment supports it.
- [ ] Run race tests for touched packages if feasible.

## Acceptance Criteria

- `Server.Stop` can be called multiple times without panic.
- Reporter shutdown paths can be called multiple times and concurrently without panic.
- Session host shutdown does not call blocking `host.Stop()` while holding `sessionHostMu`.
- Server-owned event/resource stores are closed during server shutdown.
- PTY/session cleanup no longer happens under broad server workspace locks in the touched shutdown paths.
- Tests cover idempotency, ownership, reporter shutdown, and lock discipline.
- No production API, workspace protocol, or deployment behavior is intentionally changed.
- No staging deployment is performed.
- PR is clearly marked **DO NOT MERGE** and **DO NOT DEPLOY TO STAGING**.

## Verification Plan

```bash
cd packages/vm-agent
go test ./internal/server ./internal/errorreport ./internal/messagereport ./internal/acp ./internal/pty
go test ./...
go test -race ./internal/server ./internal/errorreport ./internal/messagereport ./internal/acp ./internal/pty
```

If any verification command cannot run in this workspace, record the exact reason in the PR summary and task completion summary.
