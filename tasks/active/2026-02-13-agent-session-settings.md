# Agent Session Settings (Model, Permissions, Allowed Tools)

## Summary

Users currently have no way to configure agent behavior when starting a chat session. The ACP adapters (claude-code-acp, codex-acp, gemini) all support configuration for model selection, permission modes, and allowed/denied tools — but SAM hardcodes defaults and provides no UI for customization.

Users should be able to adjust per-agent settings including model, permission mode, and tool allow/deny rules before or during a session.

## Background: What ACP Adapters Support

### Claude Code (via claude-code-acp)

Configuration is loaded from `.claude/settings.json` files and the `NewSessionMeta` interface:

```json
{
  "permissions": {
    "allow": ["Read", "Bash(npm run:*)"],
    "deny": ["Read(./.env)", "Bash(sudo:*)"],
    "ask": ["Edit(**/*.ts)"],
    "additionalDirectories": ["/tmp"],
    "defaultMode": "ask"
  },
  "env": { "DEBUG": "true" },
  "model": "claude-sonnet-4-5-20250929"
}
```

- **Model**: Selectable via `model` field (e.g. `claude-opus-4-6`, `claude-sonnet-4-5-20250929`)
- **Permission modes**: `default` (ask for everything), `acceptEdits` (auto-approve file edits), `bypassPermissions` (skip all safety prompts)
- **Tool rules**: `allow`/`deny`/`ask` arrays with glob patterns. Precedence: deny > allow > ask
- **Environment variables**: Arbitrary env vars injected via `env` field
- **MCP servers**: Configurable via `mcpServers` in `NewSession` request

Reference: [claude-code-acp types](https://deepwiki.com/zed-industries/claude-code-acp/10.6-types-and-interfaces), [Claude Code permissions docs](https://code.claude.com/docs/en/permissions)

### OpenAI Codex (via codex-acp)

Configuration via `~/.codex/config.toml` or `.codex/config.toml`:

- **Model**: Configurable (e.g. `gpt-5-codex`, `o3`)
- **Approval mode**: `suggest` (review all changes) or `auto-edit` (auto-apply file edits)
- **MCP servers**: Configurable per-project

Reference: [Codex CLI config reference](https://developers.openai.com/codex/config-reference/)

### Google Gemini CLI

- **Model**: Configurable via environment or flags
- Runs with `--experimental-acp` flag for ACP mode

## Current SAM Implementation

Today, our gateway (`packages/vm-agent/internal/acp/gateway.go`) does the following:

1. **Initialize** with hardcoded capabilities: `{ Fs: { ReadTextFile: true, WriteTextFile: true } }`
2. **NewSession** with only `Cwd` and empty `McpServers: []`
3. **No model selection** — agent uses whatever default the API key's account allows
4. **No permission rules** — no `allow`/`deny`/`ask` arrays passed
5. **Auto-approves all permission requests** (line ~779 in gateway.go)
6. **No MCP servers** configured in sessions

## Proposed Changes

### 1. Agent Settings Data Model

Add per-user, per-agent settings stored in D1:

```typescript
interface AgentSettings {
  userId: string;
  agentType: AgentType;       // 'claude-code' | 'openai-codex' | 'google-gemini'
  model?: string;              // e.g. 'claude-opus-4-6', 'claude-sonnet-4-5-20250929'
  permissionMode?: string;     // 'default' | 'acceptEdits' | 'bypassPermissions'
  allowedTools?: string[];     // e.g. ['Read', 'Bash(npm run:*)']
  deniedTools?: string[];      // e.g. ['Bash(rm:*)', 'Bash(sudo:*)']
  additionalEnv?: Record<string, string>; // Extra env vars
  mcpServers?: McpServerConfig[];         // MCP server definitions
}
```

### 2. Settings API

- `GET /api/agent-settings/:agentType` — get user's settings for an agent
- `PUT /api/agent-settings/:agentType` — save/update settings
- `DELETE /api/agent-settings/:agentType` — reset to defaults

### 3. Settings Delivery to VM Agent

When creating an agent session, pass settings alongside the credential:

- Extend `POST /api/workspaces/:id/agent-key` response to include settings
- Or add a new `GET /api/workspaces/:id/agent-settings` callback endpoint
- VM agent gateway passes settings to the agent via:
  - **Claude Code**: Write `.claude/settings.json` in the workspace, or pass via `NewSessionMeta`
  - **Codex**: Write `.codex/config.toml` in the workspace
  - **Gemini**: Environment variables or flags

### 4. Settings UI

Add an agent settings panel accessible from:
- The Settings page (global defaults per agent)
- The workspace `+` menu (per-session override, stretch goal)

Settings panel should include:
- **Model selector** — dropdown with available models for the provider
- **Permission mode** — radio buttons (Default / Accept Edits / Bypass Permissions) with clear warnings for permissive modes
- **Tool rules** — text area or list editor for allow/deny patterns with examples
- **MCP servers** — optional advanced section for configuring external tool servers

### 5. Gateway Changes (VM Agent)

- Accept settings in the `select_agent` or session creation flow
- Write agent-specific config files before starting the agent process
- Pass model as environment variable or CLI flag where supported
- Forward permission configuration through the ACP `NewSession` metadata

## Acceptance Criteria

- [ ] Users can select a model for each agent type from the Settings page
- [ ] Users can choose a permission mode (with appropriate warnings for permissive modes)
- [ ] Users can define tool allow/deny rules
- [ ] Settings persist across sessions (stored in D1)
- [ ] Settings are delivered to the VM agent and applied when starting the agent
- [ ] Default settings work identically to current behavior (no regression)
- [ ] UI shows current model and permission mode in the workspace session

## Files Likely Affected

### API (TypeScript)
- `apps/api/src/db/schema.ts` — new `agentSettings` table
- `apps/api/src/routes/` — new agent-settings routes
- `apps/api/src/routes/workspaces.ts` — extend agent-key response with settings

### Shared
- `packages/shared/src/types.ts` — `AgentSettings` interface
- `packages/shared/src/agents.ts` — add available models per agent

### VM Agent (Go)
- `internal/acp/gateway.go` — accept and apply settings in session init
- `internal/acp/gateway.go` — write config files before agent start

### Web (React)
- `apps/web/src/pages/Settings.tsx` — agent settings panel
- `apps/web/src/lib/api.ts` — settings API client functions

## Notes

- Model availability depends on the user's API key/plan — we can't validate model access server-side, so show a text input with suggestions rather than a strict dropdown
- Permission mode `bypassPermissions` should show a strong warning — it disables all safety prompts
- MCP server configuration is an advanced feature that can be deferred to a later iteration
- Per-session overrides (vs global defaults) can also be deferred — global defaults cover the primary use case
