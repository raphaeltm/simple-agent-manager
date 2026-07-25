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

## Acceptance Criteria

- [x] `writeAgentStartupConfig` calls `writeCodexStartupConfig` even when `containerID == ""`
- [x] Standalone Codex sessions get `~/.codex/config.toml` written with SAM MCP entries
- [x] `SAM_MCP_TOKEN` env vars are appended to `startup.envVars` for standalone Codex
- [x] Container-based Codex still uses `writeCodexConfigToContainer` (backward compat)
- [x] `CODEX_HOME` env var is respected for config path resolution
- [x] Existing user config in `config.toml` is preserved via merge
- [x] No-servers case is a no-op (no file written, nil envVars)
- [x] All existing tests continue to pass

## References

- SAM Task ID: `01KYC73XXGQEWMPM5JXCCF48D7`
- Output branch: `sam/execute-task-using-skill-cf48d7`
