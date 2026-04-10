# VM Agent: Fix Data Races, Shell Injection, and Auth Bugs

## Problem

Six concurrency, security, and correctness issues in the Go VM agent (`packages/vm-agent/internal/server/`):

1. **Data race on CallbackToken** — `postTaskCallback()` reads `s.acpConfig.CallbackToken` (line 1074) without synchronization while `setCallbackToken()` writes it from the heartbeat goroutine.
2. **Data race on bootstrapComplete** — `s.bootstrapComplete` (bool, line 75) is written in `UpdateAfterBootstrap()` and read elsewhere without synchronization.
3. **Shell injection in file listing** — `handleFileList()` uses `fmt.Sprintf` + `sh -c` (files.go lines 75-84) with a quoted `dirPath`, but shell quoting is fragile. Should use direct `find` args.
4. **Flag injection in file download** — `handleFileDownload()` passes `filePath` directly to `cat` (file_transfer.go line 311) without `--` separator. A path starting with `-` could be interpreted as a flag. `handleFileRaw` already uses `cat --` (files.go line 326).
5. **Double-auth write in events endpoint** — `handleListWorkspaceEvents()` (events.go lines 40-44) calls `requireWorkspaceRequestAuth()` which writes a 401 on failure, then falls through to `requireNodeManagementAuth()` which also writes to the response. This produces garbled HTTP responses.
6. **No shared HTTP client** — `workspace_callbacks.go` (lines 69, 143) and `git_credential.go` (line 77) use `http.DefaultClient` which has no timeout. Should use a shared client with configurable timeout.

## Research Findings

- `getCallbackToken()` (health.go:18) already uses `callbackTokenMu` — just need to call it in `postTaskCallback()`.
- `handleFileRaw` (files.go:326) already uses `cat -- filePath` pattern — download handler should match.
- `requireWorkspaceRequestAuth` and `requireNodeManagementAuth` both write error responses directly. The events endpoint chains them incorrectly.
- `http.DefaultClient` appears in many files, but the task scope covers only `workspace_callbacks.go` and `git_credential.go` (the server package files).
- `postTaskCallback` already creates a local `http.Client{Timeout: 30s}` — the shared client should use the same pattern.

## Implementation Checklist

- [ ] 1. Fix CallbackToken race: replace `s.acpConfig.CallbackToken` with `s.getCallbackToken()` in `postTaskCallback()`
- [ ] 2. Fix bootstrapComplete race: change `bootstrapComplete bool` to `bootstrapComplete atomic.Bool`, update all reads to `.Load()` and writes to `.Store(true)`
- [ ] 3. Eliminate shell injection in file listing: replace `sh -c` + `find ... | head` with direct `find` args, parse and limit results in Go
- [ ] 4. Add `--` separator in file download: change `cat filePath` to `cat -- filePath` in `handleFileDownload()`
- [ ] 5. Fix double-auth write in events: extract non-writing auth check helpers, call `writeError` only once
- [ ] 6. Add shared HTTP client to Server struct, replace `http.DefaultClient.Do` in `workspace_callbacks.go` and `git_credential.go`
- [ ] 7. Add test for bootstrapComplete atomic access
- [ ] 8. Add test for handleFileDownload with path starting with `-`
- [ ] 9. Run `go vet ./...` and `go test ./...` to verify

## Acceptance Criteria

- [ ] No data race on `CallbackToken` — uses synchronized accessor
- [ ] No data race on `bootstrapComplete` — uses `atomic.Bool`
- [ ] File listing does not use shell interpolation — direct exec args only
- [ ] File download handles paths starting with `-` safely
- [ ] Events endpoint does not produce garbled responses on auth failure
- [ ] No `http.DefaultClient` usage in server package callback/credential files
- [ ] All existing tests pass, new tests added for atomic and flag-path cases
- [ ] No external API contract changes

## References

- `packages/vm-agent/internal/server/server.go`
- `packages/vm-agent/internal/server/files.go`
- `packages/vm-agent/internal/server/file_transfer.go`
- `packages/vm-agent/internal/server/events.go`
- `packages/vm-agent/internal/server/workspace_callbacks.go`
- `packages/vm-agent/internal/server/git_credential.go`
- `packages/vm-agent/internal/server/health.go`
