# Fix VM Agent Go Concurrency Bugs and Error-Handling Gaps

## Problem

Code audit identified 13 issues (3 CRITICAL, 7 HIGH, 3 MEDIUM) in the VM Agent Go code across concurrency, error handling, input validation, and security.

## Research Findings

### CRITICAL
1. **Race in SetSessionID** (`reporter.go:141-168`): Updates `r.sessionID` before clearing old session's outbox. Window exists where Enqueue reads new sessionID while old messages still in outbox.
2. **JSON decode error ignored** (`browser_handlers.go:43`): `_ = json.NewDecoder(r.Body).Decode(&req)` — malformed JSON silently accepted.
3. **io.ReadAll errors ignored**: Pattern `body, _ := io.ReadAll(...)` exists in `bootstrap.go:580`, `workspace_provisioning.go:255`, `git_credential.go:83`, `project_runtime_assets.go:75`.

### HIGH
4. **Shell injection in socat** (`socat.go:225-229`): `addForwarder` passes socat cmd via `sh -c`. Port/host are validated, but `removeForwarder` (line 236) uses `sh -c` with `pkill`. Should use `pkill` directly.
5. **JSON marshal errors ignored** (`websocket.go`): Multiple `data, _ := json.Marshal(...)` throughout the file.
6. **Workspace runtime nil-safety** (`websocket.go:191, 302`): `upsertWorkspaceRuntime` always returns non-nil, but defensive nil check is good practice.
7. **No terminal resize bounds** (`websocket.go:203-212`): Rows/cols from query params not validated.
8. **Goroutine leak in viewer pump** (`session_host.go:261`): TOCTOU — status check at line 244 can become stale by the time goroutine starts. Goroutine should self-terminate if session stops.
9. **Missing container ID validation** (`file_transfer.go:178, 202`): Container ID used in `docker exec` without format validation.
10. **No privileged port rejection** (`socat.go:215-218`): Ports < 1024 accepted in socat forwarder.

### MEDIUM
11. **Health endpoint leaks workspace count** (`routes.go:12-20`): Remove metrics from unauthenticated endpoint.
12. **COUNT(*) performance** (`reporter.go:197`): Full table scan for outbox size check.
13. **Secret env var fallback** (`process.go:243-257`): Falls back to `-e` flags (visible in `ps`).

## Implementation Checklist

### CRITICAL
- [ ] 1. Fix SetSessionID race: clear outbox BEFORE updating sessionID
- [ ] 2. Check JSON decode error in handleStartBrowser, return 400
- [ ] 3. Check io.ReadAll errors in bootstrap.go, workspace_provisioning.go, git_credential.go, project_runtime_assets.go

### HIGH
- [ ] 4. Remove shell wrapper in removeForwarder — use pkill directly via exec
- [ ] 5. Check JSON marshal errors in websocket.go (wsWriter.Write, output goroutine, session data, error data, closed data, renamed data)
- [ ] 6. Add nil-check for runtime after upsertWorkspaceRuntime in websocket handlers
- [ ] 7. Add bounds validation for rows/cols (1-500) in both handleTerminalWS and handleMultiTerminalWS resize
- [ ] 8. Add stopped-check inside viewerWritePump goroutine entry
- [ ] 9. Add container ID format validation (hex string, 12-64 chars) in file_transfer.go
- [ ] 10. Reject ports < 1024 in addForwarder

### MEDIUM
- [ ] 11. Remove activeWorkspaces and sessions counts from health endpoint
- [ ] 12. Replace COUNT(*) with bounded EXISTS query in Enqueue
- [ ] 13. Return error instead of falling back to -e flags for secrets

### Tests
- [ ] Write tests for SetSessionID race fix
- [ ] Write tests for container ID validation
- [ ] Write tests for port rejection
- [ ] Write tests for resize bounds validation
- [ ] Write tests for JSON decode error handling

## Acceptance Criteria

- [ ] All 13 findings addressed
- [ ] Existing tests pass (`go test ./...` in packages/vm-agent)
- [ ] New tests for each behavioral change
- [ ] No new linting errors
- [ ] Code compiles cleanly

## References
- packages/vm-agent/internal/messagereport/reporter.go
- packages/vm-agent/internal/server/browser_handlers.go
- packages/vm-agent/internal/browser/socat.go
- packages/vm-agent/internal/server/websocket.go
- packages/vm-agent/internal/acp/session_host.go
- packages/vm-agent/internal/server/file_transfer.go
- packages/vm-agent/internal/server/routes.go
- packages/vm-agent/internal/acp/process.go
