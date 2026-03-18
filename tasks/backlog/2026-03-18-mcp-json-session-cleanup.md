# Clean Up .mcp.json After Agent Session Ends

## Problem

The `.mcp.json` file containing SAM_MCP_TOKEN is written to the workspace directory at session start but never cleaned up after the session ends. While the token is session-scoped (has TTL), the file persists on disk unnecessarily.

## Context

Discovered during security audit of workspace-mcp PR. The `.gitignore` guard prevents accidental git commits, and `chmod 600` limits access, but cleanup would reduce the exposure window.

## Acceptance Criteria

- [ ] `.mcp.json` is deleted from the container after the agent session ends
- [ ] Cleanup is best-effort (non-fatal if it fails)
- [ ] Cleanup works for both normal stop and suspend paths
- [ ] Container ID is available at cleanup time (may need to snapshot it at start)

## References

- `packages/vm-agent/internal/acp/workspace_mcp.go`
- `packages/vm-agent/internal/acp/session_host.go` (stop/suspend paths)
- Security audit finding: MEDIUM severity
