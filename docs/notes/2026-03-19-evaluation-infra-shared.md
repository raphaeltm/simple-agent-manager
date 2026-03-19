# Infrastructure & Shared Module Evaluation

**Date**: 2026-03-19
**Scope**: `packages/vm-agent/`, `packages/shared/`, `packages/workspace-mcp/`

---

## 1. packages/vm-agent/ (Go VM Agent)

### Purpose & Scope

Single Go binary (~5k LOC) managing PTY sessions, ACP agent lifecycle, WebSocket terminal/agent relay, JWT authentication, boot logging, message persistence, and idle detection on Hetzner VMs. Well-scoped with logical `internal/` package structure: `pty/`, `acp/`, `server/`, `auth/`, `config/`, `messagereport/`, `callbackretry/`, `agentsessions/`, `idle/`.

**Verdict**: Excellent scope. Each internal package has a single responsibility.

### Code Quality

**Strengths**:
- `orderedPipe` (`internal/acp/ordered_reader.go`) is a sophisticated serialization mechanism for ACP `session/update` notifications — well-documented and solves a real SDK concurrency problem
- `AgentProcess.Stop()` has a multi-stage kill sequence (stdin close -> SIGTERM inside container -> SIGTERM host pgid -> SIGKILL) that correctly handles Docker PID namespaces
- `messagereport.Reporter` uses a two-mutex design (`mu` vs `flushMu`) with explicit lock-ordering comments for warm-node session switching
- `config.go` follows Constitution Principle XI consistently — every timeout, limit, and threshold is configurable via env var with documented defaults

**Issues**: See findings below.

### Concurrency Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **HIGH** | Data race on `orphanTimer` — set outside `session.mu` in `OrphanSession`, read/stopped under `session.mu` in `ReattachSession`. A reattached session can be destroyed by a stale timer. | `pty/manager.go:308-319` |
| **HIGH** | TOCTOU race in `CreateSessionWithID` — read lock for existence check, then write lock for insert, with a gap between. Concurrent `create_session` WebSocket messages can create duplicate sessions, leaking PTY resources. | `pty/manager.go:82-143` |
| **MEDIUM** | `gateway.Run` receives `context.Background()` — no cancellation propagation from server shutdown. Gateway only exits on WebSocket read error or write pump failure, not on graceful shutdown. | `server/agent_ws.go:180` |
| **MEDIUM** | `SelectAgent` and `HandlePrompt` spawned as fire-and-forget goroutines with no join point. No way to wait for them during shutdown. | `acp/gateway.go:348,375` |

### Resource Management Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **MEDIUM** | `handleTerminalWS` and `handleMultiTerminalWS` have no read deadline or ping/pong heartbeat. Silent client drops leave PTY sessions alive indefinitely. (ACP gateway already has correct heartbeats.) | `server/websocket.go:179-288` |
| **MEDIUM** | `Session.Close()` not idempotent — no `sync.Once` guard. Double-close path exists between `CloseSession` and `cleanupOrphanedSession` racing. | `pty/session.go:243-260` |
| **LOW** | `JWTValidator.Close()` is a no-op but the JWKS background refresh goroutine runs until process exit. | `auth/jwt.go:153-154` |

### Configuration Finding

| Severity | Finding | Location |
|----------|---------|----------|
| **LOW** | `getEnv()` treats empty string same as absent. Comment says "set to empty to disable" for `ADDITIONAL_FEATURES` but the function returns the default anyway. Fix: use `os.LookupEnv`. | `config/config.go:550-554` |

### Test Coverage

No Go test files found in `packages/vm-agent/`. The module has **zero automated test coverage**. This is the most significant gap — all findings above are theoretical until a test suite can exercise them under `-race`.

### Recommendations

1. **Fix the `orphanTimer` data race** — hold `session.mu` across the full `time.AfterFunc` lifecycle. This is the highest-severity correctness issue.
2. **Add heartbeat/deadline to PTY WebSocket handlers** — reuse `ACPPingInterval`/`ACPPongTimeout` config fields already defined.
3. **Pass `r.Context()` to `gateway.Run`** instead of `context.Background()` — propagates HTTP lifecycle through the gateway for graceful shutdown.

---

## 2. packages/shared/ (Shared TypeScript Types & Utilities)

### Purpose & Scope

~2,500 line shared types and utilities library serving as a central contract layer across the monorepo. Contains:
- `types.ts` (1,525 lines): Domain types for users, credentials, projects, tasks, nodes, workspaces, chat sessions
- `constants.ts` (522 lines): 117 exported configuration defaults and display labels
- `vm-agent-contract.ts` (271 lines): Zod schemas for VM agent HTTP boundaries
- `agents.ts` (166 lines): Agent catalog definitions and metadata
- `lib/id.ts`, `lib/validation.ts`: Utility functions

**Verdict**: Well-scoped overall, but `types.ts` (1,525 lines, 39+ exports) is too large for easy navigation.

### Code Quality

**Strengths**:
- Clean section comments separating concerns within files
- Consistent naming (PascalCase types, UPPER_SNAKE_CASE constants)
- Good discriminated unions (e.g., `CreateCredentialRequest` with provider variants)
- Zod schemas in `vm-agent-contract.ts` provide runtime validation at HTTP boundaries
- Barrel export (`index.ts`) is clean

**Issues**:
- `lib/id.ts` and `lib/validation.ts` are **not re-exported from `index.ts`** — consumers must use sub-path imports
- Inconsistent naming: some types are response-specific (`CredentialResponse`, `NodeResponse`) while others are generic (`User`, `Node`); no documented convention
- Parallel type hierarchies: shared defines `User`, `Task`, etc. as interfaces; `apps/api/src/db/schema.ts` infers them from Drizzle — no automation to keep them in sync

### Test Coverage

| File | Tests | Status |
|------|-------|--------|
| `agents.ts` | `agents.test.ts` (68 lines) | Solid — catalog uniqueness, lookup, type guards |
| `lib/id.ts` | `id.test.ts` (46 lines) | Good — generation, validation, edge cases |
| `lib/validation.ts` | `validation.test.ts` (149 lines) | Comprehensive — all validation rules |
| `constants.ts` | None | 117 exports with zero coverage |
| `types.ts` | None | No schema drift detection |
| `vm-agent-contract.ts` | None | Zod schemas untested — no round-trip or negative tests |

### Dead Code / Tech Debt

| Item | Status |
|------|--------|
| `VM_SIZE_CONFIG` | Marked `@deprecated` but still used in `NodeOverviewSection.tsx` |
| `HETZNER_IMAGE` | Backward-compat alias for `DEFAULT_HETZNER_IMAGE` — appears unused by grep |
| `WorkspaceRuntimeEnvVar`, `WorkspaceRuntimeFile`, `WorkspaceRuntimeAssetsResponse` | Exist in `types.ts` but not consumed by web or API |
| `CreateWorkspaceRequest` type | Only used in validation tests, not by API routes |

### Recommendations

1. **Export lib utilities from `index.ts`** — add `export * from './lib/id'` and `export * from './lib/validation'`. Quick win, 2 lines.
2. **Add tests for `constants.ts` and `vm-agent-contract.ts`** — verify enum/record completeness, Zod schema round-trips, and constraint enforcement. Prevents silent schema drift.
3. **Split `types.ts` into domain modules** — `src/types/user.ts`, `src/types/projects.ts`, etc. Re-export from `index.ts`. Reduces cognitive load.

---

## 3. packages/workspace-mcp/ (Workspace MCP Server)

### Purpose & Scope

Stdio MCP server providing agents inside SAM workspaces with platform-level awareness. Bridges local state (env vars, `/proc/uptime`, git status), VM agent APIs (ports, processes), and control plane APIs (project metadata, tasks, CI/CD). Ships 15 focused tools organized into categories:

| Category | Tools |
|----------|-------|
| Network & Connectivity | `get_network_info`, `expose_port`, `check_dns_status` |
| Identity & Orientation | `get_workspace_info`, `get_credential_status` |
| Cost & Resource | `check_cost_estimate`, `get_vm_resource_usage` |
| Multi-Agent Coordination | `list_agents`, `get_agent_sessions`, `call_mcp_tool` |
| Task Awareness | `get_task_dependencies` |
| CI/CD Awareness | `get_ci_status`, `get_deployment_status` |
| Observability | `get_workspace_health`, `get_workspace_diff_summary` |

Design principle: **"only build MCP tools for things that cross the container boundary"** — well-applied.

**Verdict**: Excellent scope. No tool sprawl.

### Code Quality

**Strengths**:
- Consistent `(config, apiClient, args?) => Promise<Result>` signature across all tools
- Good error handling with graceful fallbacks and structured JSON responses
- Configuration over hardcoding — timeouts configurable via `SAM_EXEC_TIMEOUT_MS`, `SAM_TLS_CHECK_TIMEOUT_MS`, `SAM_GIT_FETCH_TIMEOUT_MS`, etc.
- Zod-validated input schemas for tools with arguments

**Issues**:
- 7 tools have unused `_apiClient` parameters (reserved for future control plane calls, but undocumented)
- Silent `JSON.parse` failure for `SAM_VM_PRICING_JSON` in `cost.ts` — falls back to defaults without logging
- No retry logic for transient API failures in `api-client.ts`

### Test Coverage

~1,100 lines of tests across 10 test files — roughly 1:1 with implementation.

| Area | Coverage | Gaps |
|------|----------|------|
| Config | Comprehensive | — |
| API client | Good | — |
| Network tools | Decent | No actual shell command output parsing tests |
| Identity tools | Partial | No git command testing |
| Cost tools | Partial | No uptime calculation verification |
| Coordination tools | Good | — |
| Tasks tools | Good | — |
| CI/CD tools | Partial | No GitHub API mocking |
| Observability | Partial | No git diff output parsing |
| Server integration | Good | Tool registration verified |

### Dead Code / Tech Debt

Minimal. The only items are the unused `_apiClient` parameters (7 functions) and the silent JSON parse fallback. No abandoned code or dead modules.

### Recommendations

1. **Add shell command output parsing tests** — tools like `getNetworkInfo`, `getCiStatus`, `getWorkspaceDiffSummary` execute shell commands; tests should verify parsing of realistic `ss -tlnp`, `git diff --shortstat` output.
2. **Add configuration documentation** — 15+ configurable env vars scattered across 7 tool files with no central reference. A README with an env var table would prevent misconfiguration.
3. **Add retry logic for transient API failures** — simple exponential backoff (3 attempts) for `callMcpTool()` and `callApi()`.

---

## Cross-Cutting Observations

### Severity Summary

| Package | Critical | High | Medium | Low |
|---------|----------|------|--------|-----|
| vm-agent | 0 | 2 | 4 | 3 |
| shared | 0 | 0 | 2 | 3 |
| workspace-mcp | 0 | 0 | 1 | 2 |

### Test Coverage Comparison

| Package | Implementation LOC | Test LOC | Ratio | Rating |
|---------|-------------------|----------|-------|--------|
| vm-agent | ~5,000 Go | 0 | 0:1 | Not tested |
| shared | ~2,500 TS | ~263 | 1:10 | Partially tested |
| workspace-mcp | ~1,200 TS | ~1,100 | ~1:1 | Well tested |

### Top 5 Priority Actions (Across All Packages)

1. **vm-agent: Fix `orphanTimer` data race** — correctness bug that can destroy reattached sessions
2. **vm-agent: Fix TOCTOU race in `CreateSessionWithID`** — can leak PTY file descriptors
3. **vm-agent: Add WebSocket heartbeats to PTY handlers** — silent client drops leak resources indefinitely
4. **shared: Export lib utilities from `index.ts`** — quick fix, improves DX
5. **shared: Add tests for `vm-agent-contract.ts` Zod schemas** — prevents silent contract drift at HTTP boundaries
