# Security Hardening: CORS, Shell Quoting, JWT Validation, Encryption

## Problem Statement

Six security issues flagged in code review need targeted fixes:
1. Localhost CORS origins allowed in production
2. Shell injection via `%q` (double-quote) in `buildSAMStaticEnv`
3. JWT workspace claim bypass when `claims.Workspace` is empty
4. Stack overflow risk in `bufferToBase64` with spread operator on large buffers
5. Missing `sanitizeWorkspaceID` in `VolumeNameForWorkspace`
6. Unclamped terminal dimensions in HTTP resize handler

## Research Findings

### 1. CORS localhost in production
- `apps/api/src/index.ts:706-734`: CORS origin callback always allows localhost/127.0.0.1
- `apps/api/src/auth.ts:86-91`: `trustedOrigins` array always includes localhost:5173 and localhost:3000
- Fix: Gate behind `baseDomain.includes('localhost')` check
- Existing test: `apps/api/tests/unit/cors-config.test.ts` — must update

### 2. Shell quoting in buildSAMStaticEnv
- `packages/vm-agent/internal/bootstrap/bootstrap.go:2212`: Uses `fmt.Sprintf("export %s=%q\n", ...)` (double-quote)
- `buildSAMEnvScript` (line 2165) already uses `shellSingleQuote()` — the safer pattern
- `buildSAMStaticEnv` (line 2212) still uses `%q` which allows shell expansion
- But note: `/etc/sam/env` is described as "simple KEY=VALUE only" — it's parsed, not sourced as shell. Still, the `export` keyword and `%q` quoting mean it could be sourced. Should use single-quote for consistency.
- `shellSingleQuote` at line 2321 replaces `'` with `'"'"'` — standard POSIX safe pattern

### 3. JWT workspace claim bypass
- `packages/vm-agent/internal/auth/jwt.go:141`: `if workspaceID != "" && claims.Workspace != "" && claims.Workspace != workspaceID`
- The `claims.Workspace != ""` condition means: if a token has no workspace claim (empty), it passes the check for ANY workspaceID
- Fix: Remove the `claims.Workspace != ""` condition so empty claims fail when workspaceID is requested

### 4. bufferToBase64 stack overflow
- `apps/api/src/services/encryption.ts:9`: `btoa(String.fromCharCode(...new Uint8Array(buffer)))`
- Spread into `String.fromCharCode` puts every byte on the stack as a function argument
- For large buffers (>~100KB) this overflows the call stack
- Fix: Loop-based approach building chunks

### 5. VolumeNameForWorkspace missing sanitization
- `packages/vm-agent/internal/bootstrap/bootstrap.go:59-60`: `return volumePrefix + workspaceID` — no sanitization
- `sanitizeWorkspaceID` exists at line 1870 and strips non-alphanumeric/hyphen characters
- Other functions like `credentialHelperHostPath` already call `sanitizeWorkspaceID`

### 6. Terminal dimension clamping
- `packages/vm-agent/internal/server/routes.go:67`: `ptySession.Resize(body.Rows, body.Cols)` — no validation
- `clampTerminalDimension` exists in `websocket.go:665` and clamps to [1, 500]
- The WebSocket resize path already uses clamping, but the HTTP handler doesn't

## Implementation Checklist

- [ ] 1. Gate localhost CORS origins behind dev-mode check in `apps/api/src/index.ts`
- [ ] 2. Gate localhost trusted origins in `apps/api/src/auth.ts`
- [ ] 3. Update CORS test to verify localhost rejected in production mode
- [ ] 4. Write new CORS test for dev-mode allowing localhost
- [ ] 5. Fix `buildSAMStaticEnv` to use `shellSingleQuote` instead of `%q`
- [ ] 6. Write test for `buildSAMStaticEnv` shell quoting
- [ ] 7. Fix JWT workspace claim bypass in `ValidateNodeManagementToken`
- [ ] 8. Write JWT test: empty workspace claim must be rejected when workspaceID requested
- [ ] 9. Fix `bufferToBase64` to use loop-based approach
- [ ] 10. Write test for `bufferToBase64` with large buffer (>100KB)
- [ ] 11. Add `sanitizeWorkspaceID` call in `VolumeNameForWorkspace`
- [ ] 12. Write test for `VolumeNameForWorkspace` with malicious input
- [ ] 13. Add `clampTerminalDimension` calls in HTTP resize handler
- [ ] 14. Write test for terminal resize HTTP handler with out-of-range values
- [ ] 15. Run Go tests: `cd packages/vm-agent && go test ./...`
- [ ] 16. Run TS tests: `pnpm test && pnpm typecheck && pnpm lint`

## Acceptance Criteria

- [ ] Localhost CORS origins only allowed when BASE_DOMAIN contains "localhost" or is empty
- [ ] `buildSAMStaticEnv` uses single-quote escaping matching `buildSAMEnvScript`
- [ ] JWT validation rejects empty workspace claims when workspaceID is specified
- [ ] `bufferToBase64` handles buffers >100KB without stack overflow
- [ ] `VolumeNameForWorkspace` sanitizes workspace ID input
- [ ] HTTP terminal resize handler clamps dimensions to [1, 500]
- [ ] All existing tests continue to pass
- [ ] New tests cover each security fix
