# Fix Codex/SAM MCP Bootstrap on Standalone/CF-Container Runtimes

## Problem

Dispatched Codex tasks on standalone/cf-container runtimes fail to call SAM MCP
`get_instructions` because `writeAgentStartupConfig` returns early when
`startup.containerID == ""`. This skips `writeCodexStartupConfig`, so:

1. `~/.codex/config.toml` never gets SAM MCP server entries
2. `SAM_MCP_TOKEN` env vars are never appended to `startup.envVars`
3. Codex starts without SAM MCP access — no `get_instructions`, no project policies

Claude Code is unaffected because it receives MCP config via ACP protocol
handshake (`NewSession`/`LoadSession`), not file-based config.

## Root Cause

In `session_host_startup.go:writeAgentStartupConfig`:

```go
func (h *SessionHost) writeAgentStartupConfig(...) error {
    if startup.containerID == "" {
        return nil  // early return skips ALL agent config for standalone
    }
    if agentType == "openai-codex" {
        h.writeCodexStartupConfig(ctx, cred, startup)
    }
    // ...
}
```

The `containerID` is empty when `ContainerResolver` is nil (standalone and
cf-container workspaces). The fix moves Codex handling before the early return.

## Research Findings

- `writeCodexStartupConfig` calls `writeCodexConfigToContainer` which needs a
  container ID — but the fix branches: container path vs local filesystem path
- `resolveLocalAuthFileTargetPath` already handles `.codex/` paths with
  `CODEX_HOME` env var support (used by `injectAuthFileCredential`)
- `generateCodexMcpConfig` is a pure function — reusable for both paths
- `SAMEnvFallback` deliberately excludes `SAM_MCP_TOKEN` (it provides workspace
  identity vars only)

## Implementation Checklist

- [x] Move Codex handling in `writeAgentStartupConfig` before the `containerID == ""` early return
- [x] Branch `writeCodexStartupConfig` on `containerID`: container path vs local path
- [x] Add `writeCodexConfigLocally` function in `gateway.go` mirroring `writeCodexConfigToContainer`
- [x] Use `resolveLocalAuthFileTargetPath` for config path resolution (CODEX_HOME support)
- [x] Merge with existing config via `mergeManagedCodexMcpConfig` (same as container path)
- [x] Add unit tests for `writeCodexConfigLocally` (file creation, CODEX_HOME, merge, no-servers)
- [x] Verify Go compilation and all acp tests pass
- [x] Fail Codex startup closed with a clear diagnostic when an MCP bearer token is missing

## Acceptance Criteria

- [x] `writeAgentStartupConfig` calls `writeCodexStartupConfig` even when `containerID == ""`
- [x] Standalone Codex sessions get `~/.codex/config.toml` written with SAM MCP entries
- [x] `SAM_MCP_TOKEN` env vars are appended to `startup.envVars` for standalone Codex
- [x] Container-based Codex still uses `writeCodexConfigToContainer` (backward compat)
- [x] `CODEX_HOME` env var is respected for config path resolution
- [x] Existing user config in `config.toml` is preserved via merge
- [x] No-servers case is a no-op (no file written, nil envVars)
- [x] All existing tests continue to pass
- [x] Missing SAM MCP token prevents agent startup before config or partial env is written

## Post-Mortem

### What broke

Production Instant Codex sessions started successfully at the ACP layer but had no
SAM MCP configuration or `SAM_MCP_TOKEN`, so `sam-mcp` failed during startup and
the session could not call `get_instructions` or report task progress.

### Root cause and timeline

Standalone/cf-container support legitimately uses an empty `containerID`, but
`writeAgentStartupConfig` treated that value as a reason to skip every
agent-specific startup writer. The production failure was confirmed on
2026-07-25 from D1 state and vm-agent telemetry; the takeover on 2026-07-29 also
found that config-writer errors were logged and swallowed, which could recreate
the same MCP-less session shape.

### Why it was not caught

Tests covered Codex MCP generation and container-oriented startup separately,
but no lifecycle regression test exercised `writeAgentStartupConfig` with
`agentType="openai-codex"` and an empty container ID while asserting the actual
file and process environment. The error path also lacked a fail-closed test.

### Class of bug

Runtime-specific early returns and swallowed setup errors bypassed a
security-sensitive generated configuration boundary.

### Process fix

The behavioral lifecycle tests now assert the generated on-disk TOML and exact
environment value for standalone startup, retain coverage of the container
writer, and prove a missing MCP bearer token blocks startup with a diagnostic.
This applies the existing cross-boundary and vertical-slice requirements in
rules 23 and 35 to agent startup configuration.

## References

- SAM Task ID: `01KYC73XXGQEWMPM5JXCCF48D7`
- Output branch: `sam/execute-task-using-skill-cf48d7`
