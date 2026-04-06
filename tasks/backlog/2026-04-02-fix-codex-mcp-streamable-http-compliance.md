# Fix Codex MCP Compatibility with SAM Streamable HTTP Server

**Created**: 2026-04-02
**Priority**: High
**Classification**: `bug`

## Problem

OpenAI Codex sessions in SAM still fail to connect to the `sam-mcp` server even after the recent fixes that restored Codex auth and native MCP config injection.

The observed error in Codex is:

`MCP startup failed: handshaking with MCP server failed: ... Transport channel closed, when send initialized notification`

Claude Code and Mistral Vibe can use the same SAM MCP server successfully, so the remaining problem is not token generation or server reachability in general. The remaining gap is that SAM's `/mcp` endpoint is not fully compliant with the MCP Streamable HTTP lifecycle that Codex's native MCP client expects.

## Research Findings

### 1. Claude Code works because it does not use Codex's native config-driven MCP client

- Claude MCP servers are injected directly through ACP `NewSessionRequest.McpServers` and `LoadSessionRequest.McpServers` in [session_host.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/session_host.go#L1049) and [session_host.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/session_host.go#L1090).
- That path uses `acpsdk.McpServerHttp` objects built by `buildAcpMcpServers()` in [session_host.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/session_host.go#L47).
- Claude Code's ACP adapter handles translation from ACP MCP config to Claude's internal MCP implementation. SAM does not need to write a Claude-specific TOML/JSON config file for the main `sam-mcp` server.
- **Note**: The separate workspace-local stdio MCP server (`workspace_mcp.go` / `injectWorkspaceMcpIfAvailable()`) was removed in the unify-workspace-mcp PR. All workspace tools are now served through the main `sam-mcp` HTTP server.

### 2. Mistral Vibe works because its native MCP config path is already shaped the way Vibe expects

- Vibe requires explicit MCP entries in `~/.vibe/config.toml`, written by `writeVibeConfigToContainer()` in [gateway.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/gateway.go#L998).
- SAM generates Vibe MCP config with explicit `transport = "http"` and inline `Authorization` headers in [gateway.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/gateway.go#L977).
- The prior Vibe-specific breakage was fixed by adding the required transport discriminator, documented in `tasks/archive/2026-03-15-vibe-mcp-transport-field.md`.
- Vibe appears tolerant of SAM's current `/mcp` HTTP behavior once the config shape is valid.

### 3. Codex uses a different native MCP client path than Claude and is stricter about Streamable HTTP lifecycle semantics

- For Codex, SAM writes `~/.codex/auth.json` and `~/.codex/config.toml` before starting `codex-acp` in [session_host.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/session_host.go#L872) and [session_host.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/session_host.go#L886).
- The Codex MCP block is generated in `generateCodexMcpConfig()` in [gateway.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/gateway.go#L863) and written by `writeCodexConfigToContainer()` in [gateway.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/gateway.go#L1063).
- That generated config uses `mcp_servers.<id>.url` and `bearer_token_env_var`, which matches current Codex documentation and is likely no longer the root problem.
- Recent fixes already addressed:
  - home directory resolution for `~/.codex/*`
  - preserving existing config during merge
  - the `readOptionalFileFromContainer()` bug that prevented correct config reads

### 4. SAM's `/mcp` endpoint does not currently implement the full Streamable HTTP lifecycle

- The MCP route is POST-only at [index.ts](/workspaces/simple-agent-manager/apps/api/src/routes/mcp/index.ts#L62).
- It handles `initialize`, `tools/list`, `tools/call`, and `ping` only in [index.ts](/workspaces/simple-agent-manager/apps/api/src/routes/mcp/index.ts#L108).
- Any other method falls through to `Method not found` in [index.ts](/workspaces/simple-agent-manager/apps/api/src/routes/mcp/index.ts#L184).
- There is no handler for `notifications/initialized`.
- There is no logic that treats notification-only POSTs differently from request/response RPCs.

### 5. Codex's reported failure lines up with the missing `notifications/initialized` support

- Codex fails specifically "when send initialized notification", which is the MCP lifecycle step immediately after `initialize`.
- Under the MCP Streamable HTTP spec, `notifications/initialized` is a notification, not a request expecting a JSON-RPC result.
- Notification-only POSTs should return `202 Accepted` with no JSON-RPC response body.
- SAM currently returns JSON for all routed methods and JSON-RPC errors for unknown methods, so a Codex client sending `notifications/initialized` will receive protocol-incompatible behavior.

### 6. GET support is also incomplete for a Streamable HTTP MCP endpoint

- The spec requires both POST and GET handling for Streamable HTTP endpoints.
- If the server does not support SSE streaming, GET should still respond with `405 Method Not Allowed`, not an implicit route miss.
- SAM currently only defines a POST route for `/mcp`.
- Claude and Vibe may not rely on GET for this integration path, but Codex's native client may probe it or expect compliant behavior.

### 7. Test coverage currently stops at config generation, not interoperability

- Codex tests in [gateway_test.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/gateway_test.go#L862) verify TOML generation only.
- There are no API tests for:
  - `notifications/initialized`
  - notification-only POSTs returning `202`
  - GET behavior on `/mcp`
  - a full Codex-style initialize → initialized → tools/list → tools/call handshake

## Implementation Checklist

### A. Make the API MCP route Streamable HTTP compliant enough for Codex

- [ ] Add explicit support for `notifications/initialized` in `apps/api/src/routes/mcp/index.ts`.
- [ ] Detect JSON-RPC notifications (`id` omitted) and return `202 Accepted` with no body for successful notification handling.
- [ ] Ensure `notifications/initialized` does not fall through to the generic `Method not found` response.
- [ ] Review whether `ping` without an `id` should also be treated as a notification and handled with `202`.

### B. Add proper GET behavior for `/mcp`

- [ ] Add a GET route for `/mcp`.
- [ ] If SSE is not implemented, return `405 Method Not Allowed` with an explicit message rather than an unhandled route miss.
- [ ] Document the current transport behavior clearly so future agent integrations know whether SAM supports streaming or request/response only.

### C. Verify Codex config assumptions against current official docs

- [ ] Re-check OpenAI Codex docs for the current native MCP config schema (`.codex/config.toml`, `mcp_servers.<id>.url`, `bearer_token_env_var`).
- [ ] Verify whether project-scoped `.codex/config.toml` should be preferred over `~/.codex/config.toml` for SAM sessions.
- [ ] If project-scoped config is preferred and supported by `codex-acp`, file or implement a follow-up change to reduce home-directory fragility.

### D. Add behavioral tests for the MCP server lifecycle

- [ ] Add API tests covering `initialize` request handling.
- [ ] Add API tests covering `notifications/initialized` as a notification-only POST and assert `202` with no response body.
- [ ] Add API tests covering `tools/list` and `tools/call get_instructions` after initialization.
- [ ] Add API tests covering GET `/mcp` behavior.
- [ ] Add an integration-style test that exercises the exact lifecycle a strict HTTP MCP client would use:
- [ ] `initialize`
- [ ] `notifications/initialized`
- [ ] `tools/list`
- [ ] `tools/call` for `get_instructions`

### E. Add Codex-focused interoperability validation

- [ ] Add a mock or fixture-driven test that simulates Codex's native MCP HTTP handshake against the SAM `/mcp` route.
- [ ] Capture and document the expected HTTP status/body behavior for each lifecycle step so regressions are obvious.
- [ ] If possible in staging, verify with a real Codex-backed agent session that `get_instructions` succeeds after the server changes.

### F. Documentation

- [ ] Update `docs/architecture/credential-security.md` to separate "Codex auth/config injection works" from "Codex MCP handshake is compatible".
- [ ] Add a note in the relevant MCP architecture docs that Claude, Vibe, and Codex use different MCP integration paths and therefore have different failure modes.

## Acceptance Criteria

- [ ] A Codex session can complete MCP startup against SAM without the `Transport channel closed` handshake failure.
- [ ] A Codex session can successfully call `get_instructions` from `sam-mcp`.
- [ ] Claude Code sessions still work unchanged.
- [ ] Mistral Vibe sessions still work unchanged.
- [ ] `/mcp` correctly handles `notifications/initialized` as a notification.
- [ ] `/mcp` has explicit GET behavior compliant with Streamable HTTP expectations.
- [ ] Automated tests cover the lifecycle steps that previously failed for Codex.

## References

- [apps/api/src/routes/mcp/index.ts](/workspaces/simple-agent-manager/apps/api/src/routes/mcp/index.ts)
- [packages/vm-agent/internal/acp/session_host.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/session_host.go)
- [packages/vm-agent/internal/acp/gateway.go](/workspaces/simple-agent-manager/packages/vm-agent/internal/acp/gateway.go)
- ~~`packages/vm-agent/internal/acp/workspace_mcp.go`~~ (removed — workspace tools unified into sam-mcp)
- `tasks/archive/2026-03-07-agent-platform-awareness-mcp.md`
- `tasks/archive/2026-03-15-fix-vibe-mcp-configuration.md`
- `tasks/archive/2026-03-15-vibe-mcp-transport-field.md`
- `tasks/archive/2026-04-02-fix-codex-acp-home-directory-resolution.md`
- OpenAI Codex config reference
- MCP Streamable HTTP lifecycle and transport specs
