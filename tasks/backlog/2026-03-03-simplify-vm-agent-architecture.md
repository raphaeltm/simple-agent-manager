# Simplify VM Agent Architecture

**Status:** backlog
**Priority:** high
**Estimated Effort:** 1 week
**Created:** 2026-03-03

## Problem Statement

The Go VM agent (`packages/vm-agent/`) has grown into a complex system where responsibilities are scattered across files without clear boundaries. The main complexity hotspots:

- `internal/acp/session_host.go` is 1,880 lines with 6 separate mutexes managing agent lifecycle, message buffering, viewer management, prompt state, auto-suspend, and stderr collection — potential deadlock risk
- `internal/server/workspaces.go` is 911 lines handling both workspace CRUD and agent session lifecycle
- `internal/server/workspace_routing.go` (548 lines) mixes route header extraction, 3 overlapping auth mechanisms, workspace state machines, and event management
- `internal/server/server.go` (873 lines) contains git push/PR creation business logic that doesn't belong in the server package
- `internal/bootstrap/bootstrap.go` is 2,131 lines of monolithic provisioning
- Three overlapping auth mechanisms (`requireWorkspaceRequestAuth`, `requireNodeManagementAuth`, `authenticateWorkspaceWebsocket`) with duplicated workspace claim checking
- Three separate control plane reporters (`bootlog/`, `errorreport/`, `messagereport/`) with similar interfaces
- No `WorkspaceManager` interface — workspace state operations scattered across files
- Error handling patterns inconsistent (some `os.Exit(1)`, some return errors, some log-and-continue)

## Acceptance Criteria

- [ ] Split `SessionHost` (1,880 lines) into focused structs:
  - `SessionHost` — owns agent process and lifecycle only
  - `SessionMessageBuffer` — message buffer with its own lock
  - `SessionViewerGroup` — viewer management with its own lock
  - `SessionPrompt` — prompt state machine encapsulating the 3 prompt-related mutexes
  - Document lock ordering to prevent deadlocks
- [ ] Extract agent session handlers from `workspaces.go` into `agent_session_handlers.go`
- [ ] Extract git operations from `server.go` into `internal/workspacegit/`:
  - `GitPusher` struct with `PushChanges()` and `CreatePR()` methods
  - Move task completion callback git logic out of server package
- [ ] Consolidate auth into `internal/auth/workspace_auth.go`:
  - Single `AuthorizeWorkspaceRequest()` function replacing 3 overlapping mechanisms
  - Eliminate duplicated workspace claim mismatch logic
- [ ] Merge control plane reporters into `internal/controlplane/`:
  - Unified `Reporter` interface covering bootlog, error, and message reporting
  - Reduces package count by 3
- [ ] Create `internal/errors/` package with typed errors:
  - `AuthError`, `TransientError`, `ConfigError`
  - Consistent error classification across the agent
- [ ] Extract workspace state machine into `internal/server/workspace_state.go`:
  - Clear `WorkspaceManager` interface
  - Document valid state transitions with CAS enforcement
- [ ] All existing Go tests pass (`go test ./...`)
- [ ] No functional changes — pure structural refactor

## Key Files

- `packages/vm-agent/internal/acp/session_host.go` (1,880 lines, 6 mutexes)
- `packages/vm-agent/internal/server/workspaces.go` (911 lines)
- `packages/vm-agent/internal/server/workspace_routing.go` (548 lines)
- `packages/vm-agent/internal/server/server.go` (873 lines)
- `packages/vm-agent/internal/server/workspace_provisioning.go` (370 lines)
- `packages/vm-agent/internal/bootstrap/bootstrap.go` (2,131 lines)
- `packages/vm-agent/internal/bootlog/reporter.go`
- `packages/vm-agent/internal/errorreport/reporter.go`
- `packages/vm-agent/internal/messagereport/reporter.go`
- `packages/vm-agent/internal/config/config.go` (537 lines — flat env loading)

## Approach

1. Start with auth consolidation — most impactful for bug prevention
2. Extract git operations — clear boundary, independent of other changes
3. Merge reporters — reduces package count, simplifies startup
4. Split SessionHost last — highest risk, requires careful testing
5. Run `go test ./... -race` after each major extraction
