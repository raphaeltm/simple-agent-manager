# VM Agent: http.DefaultClient Hardening & Config Validation

**Created**: 2026-04-14
**Priority**: HIGH (CTO code review finding)

## Problem Statement

The Go VM agent uses `http.DefaultClient` (zero timeout) for outbound HTTP calls to the control plane, has no config validation beyond type parsing, uses hardcoded weak default passwords for Neko browser sidecar, and silently swallows parse errors in env var helpers.

## Research Findings

### 1. http.DefaultClient Usage (4 locations)
- `internal/bootstrap/bootstrap.go:627` — `redeemBootstrapToken()`: bootstrap token redemption
- `internal/bootstrap/bootstrap.go:2425` — workspace-ready callback (already has 30s context timeout but no client timeout)
- `internal/acp/session_host.go:2067` — `fetchAgentCredential()`: agent credential fetch
- `internal/acp/session_host.go:2123` — `fetchAgentSettings()`: agent settings fetch

### 2. Existing HTTP Client Pattern
- `internal/server/server.go:90` has `controlPlaneHTTPClient(timeout)` factory on Server struct
- Other packages (errorreport, bootlog, messagereport) already create `&http.Client{Timeout: ...}`
- The config already has `HTTPCallbackTimeout` (default 30s) — can reuse as the default timeout

### 3. Config Validation
- `Config` struct has 100+ fields, ~227 lines of struct definition
- `Load()` already validates: TLS cert/key paths, ControlPlaneURL non-empty, NodeID non-empty, TaskMode enum, MaxWorktreesPerWorkspace min
- No `Validate()` method exists; validation is inline in `Load()`
- `MaxWorkspacesPerNode` does NOT exist in VM agent config (it's an API-side concept)
- Port is `Port int` with default 8080 — no range validation

### 4. Neko Default Passwords
- `config.go:420`: `NekoPassword` defaults to `"neko"`
- `config.go:421`: `NekoPasswordAdmin` defaults to `"admin"`
- These are passed to the Neko Docker container — weak defaults are a security risk

### 5. Env Var Parse Helpers (silent failures)
- `getEnvInt` (line 647): silently falls back on parse error
- `getEnvBool` (line 670): silently falls back on parse error
- `getEnvDuration` (line 680): silently falls back on parse error
- `getEnvInt64` (line 657): already HAS the warning pattern — this is the model to follow

### 6. Key Files
- `packages/vm-agent/internal/config/config.go` — config struct and loading
- `packages/vm-agent/internal/config/config_test.go` — existing tests
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — bootstrap HTTP calls
- `packages/vm-agent/internal/acp/session_host.go` — ACP HTTP calls
- `packages/vm-agent/internal/acp/gateway.go` — GatewayConfig struct
- `packages/vm-agent/internal/server/server.go` — existing HTTP client factory
- `packages/vm-agent/main.go` — calls config.Load()

## Implementation Checklist

### 1. Create shared HTTP client helper in config package
- [ ] Add `NewControlPlaneClient(timeout time.Duration) *http.Client` function to config package
- [ ] Use sensible defaults (30s timeout if 0 passed)

### 2. Replace http.DefaultClient in bootstrap.go
- [ ] Replace `http.DefaultClient.Do(req)` at line 627 with timeout-configured client
- [ ] Replace `http.DefaultClient.Do(req)` at line 2425 with timeout-configured client

### 3. Replace http.DefaultClient in session_host.go
- [ ] Add `httpClient *http.Client` field to `SessionHostConfig` or `GatewayConfig`
- [ ] Replace `http.DefaultClient.Do(req)` at line 2067 with configured client
- [ ] Replace `http.DefaultClient.Do(req)` at line 2123 with configured client
- [ ] Wire the client from server.go when constructing SessionHost configs

### 4. Add Config.Validate() method
- [ ] Create `Validate() error` method on Config struct
- [ ] Validate Port in range 1-65535
- [ ] Validate TLS cert/key paths exist when TLS is enabled (move from Load)
- [ ] Validate numeric ranges: SessionMaxCount > 0, DefaultRows/Cols > 0
- [ ] Validate ControlPlaneURL is a valid URL
- [ ] Call Validate() after Load() in main.go

### 5. Generate random Neko default passwords
- [ ] Add `generateRandomPassword(length int) string` using crypto/rand
- [ ] Replace hardcoded "neko" and "admin" defaults with generated passwords
- [ ] Log warning if operator explicitly sets weak passwords (< 8 chars)

### 6. Add parse warnings to env var helpers
- [ ] Add `slog.Warn` to `getEnvInt` on parse failure (match getEnvInt64 pattern)
- [ ] Add `slog.Warn` to `getEnvBool` on parse failure
- [ ] Add `slog.Warn` to `getEnvDuration` on parse failure

### 7. Tests
- [ ] Unit tests for Validate() — valid config, missing TLS paths, invalid port, etc.
- [ ] Unit tests for random password generation
- [ ] Unit tests for env var parse warning behavior
- [ ] Run `go test ./...` and `go vet ./...`

## Acceptance Criteria

- [ ] No `http.DefaultClient` usage remains in the VM agent
- [ ] All outbound HTTP calls use clients with explicit timeouts
- [ ] Config.Validate() catches invalid port ranges, missing TLS paths, invalid URLs
- [ ] Neko passwords default to cryptographically random values
- [ ] Unparseable env vars produce slog.Warn messages
- [ ] All existing tests pass
- [ ] New tests cover validation, password generation, and parse warnings
- [ ] No function signature changes to externally-called functions
- [ ] No HTTP endpoint behavior changes
