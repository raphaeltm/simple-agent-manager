# Fix Mistral Vibe MCP Server Configuration

## Problem Statement
Mistral Vibe agents running in SAM workspaces cannot access MCP tools like `get_instructions` because:

1. Claude Code has built-in MCP client support and automatically discovers MCP servers via ACP protocol
2. Mistral Vibe requires explicit MCP server configuration in `~/.vibe/config.toml`
3. The VM agent writes a vibe config file but only includes model aliases, not MCP server configuration
4. The MCP token is generated and passed via ACP protocol, but vibe ignores it without config file entries

## Research Findings

### Key Files Identified:
- `packages/vm-agent/internal/acp/session_host.go` - Writes vibe config but missing MCP servers
- `packages/vm-agent/internal/acp/gateway.go` - Contains MCP server structures and logic
- `apps/api/src/durable-objects/task-runner.ts` - Generates MCP tokens and passes to VM agent
- `apps/api/src/services/node-agent.ts` - Calls VM agent with MCP server config

### Current Behavior:
1. Task-runner generates MCP token ✅
2. Task-runner calls VM agent with MCP server URL + token ✅  
3. VM agent starts `vibe-acp` with MCP servers via ACP protocol ✅
4. VM agent writes `~/.vibe/config.toml` with model aliases ✅
5. **MISSING**: MCP server configuration in vibe config ❌
6. Vibe agent can't discover MCP tools ❌

### Expected Behavior:
- Vibe config should include MCP server entries so vibe can discover tools
- MCP servers should be written to `~/.vibe/config.toml` in the correct format
- Vibe should be able to call `get_instructions` and other MCP tools

## Implementation Checklist

### 1. Modify VM Agent Config Generation
- [ ] Update `writeVibeConfigToContainer` function to accept MCP servers parameter
- [ ] Add MCP server configuration to generated TOML config
- [ ] Follow vibe's MCP server config format (see vibe documentation)

### 2. Pass MCP Servers to Config Function
- [ ] Modify `startAgent` in session_host.go to pass MCP servers to config function
- [ ] Extract MCP servers from GatewayConfig.McpServers
- [ ] Convert acp.McpServerEntry to vibe MCP server format

### 3. Update Gateway Integration
- [ ] Ensure SessionHost has access to MCP servers when starting agent
- [ ] Pass MCP servers from GatewayConfig to startAgent function

### 4. Testing
- [ ] Add unit tests for MCP config generation
- [ ] Test with both API key and OAuth token authentication
- [ ] Verify vibe can discover and call MCP tools

## Acceptance Criteria

1. **MCP Configuration Written**: Vibe config file includes proper MCP server entries
2. **Tool Discovery Works**: Vibe agent can discover `get_instructions` and other MCP tools
3. **Authentication Works**: MCP token is properly passed and used for authentication
4. **Backward Compatibility**: Claude Code agents continue to work unchanged
5. **No Breaking Changes**: Existing vibe functionality remains intact

## References

- SAM Architecture: `docs/architecture/walkthrough.md`
- MCP Server Design: `packages/vm-agent/internal/acp/gateway.go`
- Vibe Configuration: `packages/vm-agent/internal/acp/session_host.go:860-880`
- Task Runner: `apps/api/src/durable-objects/task-runner.ts:865-905`
- Node Agent Service: `apps/api/src/services/node-agent.ts:273-300`

## Technical Notes

### Vibe MCP Server Format
Based on vibe documentation and source code, MCP servers in config.toml should follow:
```toml
[[mcp_servers]]
name = "sam-mcp"
url = "https://api.domain/mcp"
headers = { Authorization = "Bearer <token>" }
```

### Security Considerations
- MCP tokens are already generated with TTL and stored securely in KV
- No additional security changes needed - just proper config file generation
- Tokens are workspace-scoped and short-lived

### Error Handling
- If MCP server config fails to write, log warning but don't fail agent start
- Vibe will fall back to built-in tools (current behavior)
- Include error details in logs for debugging