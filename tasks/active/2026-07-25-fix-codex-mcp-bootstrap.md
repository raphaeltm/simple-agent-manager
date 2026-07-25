# Fix Codex/SAM MCP Bootstrap for Standalone/CF-Container Sessions

## Problem

Dispatched Codex tasks on standalone and cf-container runtimes fail to load SAM MCP tools because `writeAgentStartupConfig` returns early when `startup.containerID == ""`. This means:

1. `writeCodexStartupConfig` is never called
2. No `~/.codex/config.toml` is written with MCP server entries
3. No `SAM_MCP_TOKEN` env vars are injected into the agent process
4. Codex starts without any SAM MCP server access → `get_instructions` fails

Claude Code is unaffected because it receives MCP config via the ACP protocol handshake (`NewSession`/`LoadSession`), not via file-based config.

## Root Cause

`packages/vm-agent/internal/acp/session_host_startup.go:420-423`:

```go
func (h *SessionHost) writeAgentStartupConfig(...) error {
    if startup.containerID == "" {
        return nil  // ← BUG: skips ALL agent config writing
    }
    ...
}
```

`containerID` is empty when `h.config.ContainerResolver` is nil, which is the case for standalone (cf-container) workspaces.

## Research Findings

1. **The early return skips all agent types** — Codex, OpenCode, and Vibe all skip config writing in standalone mode.
2. **Existing standalone pattern exists** — `injectAuthFileCredential` at line 196 already handles the `containerID == ""` case by using `resolveLocalAuthFileTargetPath` + `os.WriteFile` to write to the local filesystem.
3. **`resolveLocalAuthFileTargetPath`** already handles Codex paths: when `authFilePath` starts with `.codex/`, it honors `CODEX_HOME` env var.
4. **`generateCodexMcpConfig`** is pure (no I/O) and already returns the config string + env vars — only the write target differs.
5. **`SAMEnvFallback`** provides workspace identity vars but intentionally does NOT include `SAM_MCP_TOKEN` (it's a per-session token, not a static config value).
6. **The same fix pattern applies to OpenCode and Vibe** but they may have other standalone considerations; scope this PR to Codex only unless the pattern is identical.

## Implementation Checklist

- [ ] 1. Remove the early return in `writeAgentStartupConfig` when `containerID == ""`
- [ ] 2. Add `writeCodexConfigLocally` function in `gateway.go` that writes config.toml to the local filesystem using `resolveLocalAuthFileTargetPath` pattern
- [ ] 3. Update `writeCodexStartupConfig` to branch: local write when `containerID == ""`, container write otherwise
- [ ] 4. Ensure env vars (`SAM_MCP_TOKEN`) are appended to `startup.envVars` in both paths
- [ ] 5. Add structured logging for the standalone config write path (without leaking token values)
- [ ] 6. Add unit test: `TestWriteCodexConfigLocally` — writes config.toml to temp dir, verifies content
- [ ] 7. Add unit test: `TestWriteAgentStartupConfig_StandaloneCodex` — verifies the early return is removed and config is written
- [ ] 8. Add unit test: `TestWriteAgentStartupConfig_StandaloneCodex_McpEnvVarsInjected` — verifies SAM_MCP_TOKEN ends up in startup.envVars
- [ ] 9. Verify OpenCode/Vibe standalone paths — check if they also need the same fix (at minimum, remove early return so they can run)
- [ ] 10. Run existing tests: `go test ./internal/acp/... ./internal/config/...`
- [ ] 11. Run full quality suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

## Acceptance Criteria

- [ ] Codex agents on standalone/cf-container runtimes get `~/.codex/config.toml` written with SAM MCP server entries
- [ ] `SAM_MCP_TOKEN` env var is injected into the agent process environment
- [ ] The fix is backward-compatible: container-based Codex sessions still work via the existing `writeCodexConfigToContainer` path
- [ ] No secrets are logged (token values must not appear in log output)
- [ ] Structured diagnostic logging covers the standalone config write path
- [ ] Tests cover the standalone bootstrap contract
- [ ] Draft PR opened, not merged

## References

- `packages/vm-agent/internal/acp/session_host_startup.go` — the buggy early return and agent startup flow
- `packages/vm-agent/internal/acp/gateway.go` — `generateCodexMcpConfig`, `writeCodexConfigToContainer`
- `packages/vm-agent/internal/config/env_fallback.go` — `BuildSAMEnvFallback`
- Knowledge: `AgentReliability` entry confirmed 2026-07-25
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md` — Go testing patterns
