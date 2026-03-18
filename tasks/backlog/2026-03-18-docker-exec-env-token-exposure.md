# Docker Exec -e Token Exposure in Process Table

## Problem

Agent environment variables (ANTHROPIC_API_KEY, GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) are passed to containers via `docker exec -e KEY=VALUE` flags in `packages/vm-agent/internal/acp/process.go:150-152`. This makes token values visible in `/proc/<pid>/cmdline` on the VM host for the duration of the docker exec process.

## Context

Discovered during security audit of workspace-mcp PR. The workspace-mcp `.mcp.json` injection correctly uses stdin piping to avoid this issue, but the main agent process startup still uses `-e` flags.

## Acceptance Criteria

- [ ] Secret env vars (ANTHROPIC_API_KEY, GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, SAM_MCP_TOKEN) are NOT visible in host process table
- [ ] Use either `docker exec --env-file` with tmpfs-backed temp file, or stdin-pipe technique (like writeWorkspaceMcpConfig)
- [ ] Non-secret env vars (SAM_WORKSPACE_ID, etc.) may remain as `-e` flags
- [ ] Existing agent startup behavior is preserved
- [ ] Test verifies no secret values appear in constructed docker command args

## References

- `packages/vm-agent/internal/acp/process.go:150-152`
- Security audit finding: HIGH severity
