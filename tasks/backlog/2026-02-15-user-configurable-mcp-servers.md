# User-Configurable MCP Servers

**Created**: 2026-02-15
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Large

## Context

Currently, SAM workspaces install MCP servers during devcontainer provisioning via `.devcontainer/post-create.sh`. These servers (playwright, sequential-thinking, context7, cloudflare-observability) are hardcoded and installed for all workspaces.

When users access workspaces through the SAM web interface, they interact with Claude Code via the **Agent SDK** (`CLAUDECODE=1`, `CLAUDE_AGENT_SDK_VERSION=0.2.38`), not the native Claude CLI. The SDK-based agent execution path does not currently have access to MCP servers configured via `claude mcp add`.

We need to explore how users can install and configure their own MCP servers when using SAM workspaces.

## Problem Statement

Users cannot currently:
1. Choose which MCP servers to install in their workspaces
2. Add custom MCP servers beyond the hardcoded defaults
3. Configure MCP server settings (environment variables, arguments)
4. Access MCP servers when using the workspace through the web UI (SDK-based agents)

## Research Findings

### How Happy Coder Handles MCP Servers

Happy Coder is a mobile/web client for Claude Code that successfully supports MCP servers. Key findings:

1. **Configuration Location**: MCP servers are configured via `~/.config/claude/mcp.json`
2. **Configuration Format**:
   ```json
   {
     "mcpServers": {
       "happy-manager": {
         "command": "npx",
         "args": ["@zhigang1992/happy-server-mcp"]
       }
     }
   }
   ```
3. **Permission System**: Happy includes a real-time permission system that intercepts MCP tool calls and presents users with Allow/Deny prompts before execution
4. **Works with SDK**: Happy successfully makes MCP servers available to agents running through their platform

### Claude Code MCP Configuration Patterns

Based on official Claude Code documentation:

#### Three Configuration Scopes

1. **Local scope** (`~/.claude.json` under project path)
   - Private to user, only in current project
   - Default scope for `claude mcp add`

2. **Project scope** (`.mcp.json` in project root)
   - Shared with team via version control
   - Requires approval prompt for security
   - Can be reset with `claude mcp reset-project-choices`

3. **User scope** (`~/.claude.json`)
   - Available across all projects
   - Private to user account

#### Environment Variable Expansion

`.mcp.json` files support environment variable expansion:
- `${VAR}` - Expands to environment variable value
- `${VAR:-default}` - Uses default if not set
- Works in: `command`, `args`, `env`, `url`, `headers`

Example:
```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

#### MCP Server Types

1. **HTTP Transport** (recommended for remote servers)
   ```bash
   claude mcp add --transport http <name> <url>
   ```

2. **Stdio Transport** (for local processes)
   ```bash
   claude mcp add --transport stdio <name> -- <command> [args...]
   ```

3. **SSE Transport** (deprecated, use HTTP instead)

#### Tool Search for Scaling

- Automatically enabled when MCP tools exceed 10% of context window
- Dynamically loads tools on-demand instead of preloading
- Configurable via `ENABLE_TOOL_SEARCH` environment variable
- Values: `auto`, `auto:<N>`, `true`, `false`

#### Plugin-Provided MCP Servers

Plugins can bundle MCP servers that start automatically when enabled:
- Defined in `.mcp.json` at plugin root or inline in `plugin.json`
- Use `${CLAUDE_PLUGIN_ROOT}` for plugin-relative paths
- Managed through plugin installation (not `/mcp` commands)

#### Managed MCP Configuration (Enterprise)

Organizations can control MCP servers two ways:

1. **Exclusive Control** (`managed-mcp.json`):
   - Deploy to system-wide directory (requires admin privileges)
   - Users cannot add/modify servers
   - Paths:
     - macOS: `/Library/Application Support/ClaudeCode/managed-mcp.json`
     - Linux/WSL: `/etc/claude-code/managed-mcp.json`
     - Windows: `C:\Program Files\ClaudeCode\managed-mcp.json`

2. **Policy-Based Control** (allowlists/denylists):
   - Users can add servers within policy constraints
   - Use `allowedMcpServers` and `deniedMcpServers` in managed settings
   - Restrictions by: server name, command, or URL pattern

## Proposed Approaches

### Option A: Per-User .mcp.json in Workspace

**How it works**:
1. Store user's MCP server preferences in database (encrypted, per-user)
2. During workspace provisioning, inject `.mcp.json` into workspace filesystem
3. Use project-scope configuration so it's available to Claude Code SDK agents
4. Support environment variable expansion for API keys

**Pros**:
- Follows Claude Code's standard configuration pattern
- Users can configure via SAM Settings UI
- Secure credential storage (encrypted in database)
- Works with SDK-based agents

**Cons**:
- Requires UI for MCP server management
- Need to handle credential injection securely
- May need workspace restart to apply changes

### Option B: GitHub Repository .mcp.json

**How it works**:
1. Users commit `.mcp.json` to their repository
2. During workspace provisioning, file is present from git clone
3. Environment variables injected from user credentials (stored in database)
4. Optional: SAM UI can edit the file for convenience

**Pros**:
- Portable across platforms (not SAM-specific)
- Version controlled with code
- No UI implementation required initially
- Works with SDK-based agents

**Cons**:
- Cannot commit secrets to repo (must use env vars)
- Requires understanding of `.mcp.json` format
- Changes require git commit + workspace restart

### Option C: Plugin-Based MCP Marketplace

**How it works**:
1. Create SAM-specific plugin system for MCP servers
2. Users browse/install from marketplace UI
3. Plugins bundle MCP server configurations
4. SAM injects plugin `.mcp.json` files during provisioning

**Pros**:
- User-friendly (no JSON editing)
- Curated, tested integrations
- Can include setup instructions and defaults

**Cons**:
- Large implementation effort
- Need to build marketplace infrastructure
- Maintenance burden for SAM team

### Option D: Hybrid Approach (Recommended)

**How it works**:
1. **Phase 1**: Support `.mcp.json` in user repositories (Option B)
   - Document how to add MCP servers to `.mcp.json`
   - Support environment variable expansion from user credentials
   - No SAM UI changes required
   
2. **Phase 2**: Add SAM Settings UI for MCP servers (Option A)
   - Visual editor for adding/removing MCP servers
   - Stores preferences in database
   - Generates `.mcp.json` during provisioning
   - Supports both user-defined and repo-committed configs

3. **Phase 3**: Consider plugin marketplace (Option C)
   - Only if there's significant user demand
   - Focus on popular integrations

**Pros**:
- Immediate solution (Phase 1) with minimal effort
- Progressive enhancement toward better UX
- Flexible: supports both power users and beginners

**Cons**:
- Multi-phase implementation
- Need to handle conflicts between repo and user configs

## Technical Considerations

### Environment Variable Injection

Need secure way to inject user credentials for MCP servers:
1. User stores API keys in SAM Settings (encrypted in database)
2. Bootstrap process includes MCP-related env vars
3. `.mcp.json` references via `${VAR_NAME}`

Example user flow:
1. User adds GitHub token to SAM Settings
2. User adds to `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "github": {
         "type": "http",
         "url": "https://api.githubcopilot.com/mcp/",
         "headers": {
           "Authorization": "Bearer ${GITHUB_TOKEN}"
         }
       }
     }
   }
   ```
3. SAM injects `GITHUB_TOKEN` during workspace bootstrap

### SDK Agent MCP Access

Key question: **How does the Claude Code SDK discover and connect to MCP servers?**

Research needed:
- [ ] Review Claude Code Agent SDK documentation
- [ ] Inspect Happy Coder source code to see how they bridge SDK to MCP
- [ ] Test if `.mcp.json` in project directory is automatically detected by SDK agents
- [ ] Determine if additional SDK configuration is needed

Hypothesis: If Claude Code SDK respects standard config files (`.mcp.json`, `~/.claude.json`), then project-scope or workspace-local configs should work automatically.

### Configuration Precedence

If implementing hybrid approach, need clear precedence:
1. **Denylist** (if we implement managed configs)
2. **User preferences** (from SAM database)
3. **Repository `.mcp.json`** (from git)
4. **SAM defaults** (current hardcoded list)

### Security Considerations

1. **Allowlist/Denylist**: Should SAM administrators be able to restrict which MCP servers users can install?
2. **Command Execution**: Stdio MCP servers run arbitrary commands - how to prevent malicious servers?
3. **Credential Scoping**: Ensure user credentials are only accessible to their own workspaces
4. **Audit Logging**: Log MCP server installations and tool calls for security review

## Next Steps

1. **Research Happy Coder Implementation**
   - [ ] Clone Happy Coder repository
   - [ ] Find how they bridge SDK to MCP servers
   - [ ] Identify any custom patches or workarounds

2. **Prototype Phase 1 (Repo-based .mcp.json)**
   - [ ] Test if SDK agents automatically detect `.mcp.json` in project directory
   - [ ] Implement environment variable injection for MCP credentials
   - [ ] Document setup instructions for users

3. **Evaluate Results**
   - [ ] If SDK auto-detection works, proceed with Phase 2 (Settings UI)
   - [ ] If not, investigate how Happy Coder solves this problem

4. **Design Settings UI (Phase 2)**
   - [ ] MCP server list view
   - [ ] Add/edit/remove server forms
   - [ ] Credential management integration
   - [ ] Workspace restart flow

## References

- [Happy Coder Documentation](https://happy.engineering/docs/)
- [Happy Coder GitHub](https://github.com/slopus/happy)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)
- [MCP SDK Documentation](https://modelcontextprotocol.io/introduction)
- [Claude API Agent SDK MCP Docs](https://platform.claude.com/docs/en/agent-sdk/mcp)

## Related Files

- `.devcontainer/post-create.sh` - Current MCP server installation
- `apps/api/src/db/schema.ts` - User credentials schema
- `packages/cloud-init/src/template.ts` - Workspace bootstrap process

## Success Criteria

- [ ] Users can specify which MCP servers to install in their workspaces
- [ ] MCP servers are accessible when using workspace through SAM web UI (SDK agents)
- [ ] Users can securely provide API keys/credentials for MCP servers
- [ ] Configuration is persistent across workspace restarts
- [ ] Clear documentation for adding custom MCP servers
- [ ] (Optional) Visual UI for managing MCP servers without editing JSON
