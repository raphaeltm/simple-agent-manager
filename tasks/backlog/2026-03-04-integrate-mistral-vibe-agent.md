# Integrate Mistral Vibe as a Fourth Agent Type

**Created**: 2026-03-04
**Updated**: 2026-03-13
**Priority**: Medium
**Effort**: Small-Medium (1-2 sessions)

## Context

[Mistral Vibe](https://mistral.ai/products/vibe) is Mistral AI's terminal-native coding agent, powered by the Devstral 2 model family. It is [open source (Apache 2.0)](https://github.com/mistralai/mistral-vibe) and provides an ACP-compatible binary (`vibe-acp`) that communicates over stdin/stdout JSON-RPC — the same protocol SAM already uses for Claude Code, Codex, and Gemini CLI.

Adding Vibe as a fourth agent gives users access to Mistral's models (Devstral 2) through SAM's existing agent infrastructure with minimal new code.

### Why This Is Straightforward

Unlike Claude Code (API key + OAuth) or Codex (API key + OAuth + file-based injection + credential sync-back), Mistral Vibe uses **only a single API key** (`MISTRAL_API_KEY`). No OAuth flows, no file-based injection, no credential sync-back. This makes it the simplest possible agent integration — on par with Gemini CLI.

## Technical Analysis

### ACP Compatibility (VERIFIED — Not a Blocker)

ACP uses **two separate version numbers**:
- **Protocol version** (integer) — only bumped for **breaking changes**. Currently `1` everywhere.
- **Schema version** (semver) — tracks SDK/spec releases with additive changes. Backward-compatible within the same protocol version.

| Component | Schema Version | Protocol Version |
|-----------|---------------|-----------------|
| SAM (`acp-go-sdk v0.6.3`) | 0.6.3 | **1** |
| Vibe (`vibe-acp`) | ~0.8.0 | **1** |
| ACP spec (latest) | 0.10.8 | **1** |
| Go SDK main (unreleased) | 0.10.8 | **1** |

**All agents negotiate protocol version `1` — they are fully compatible.** The schema version differences only add new optional methods/capabilities. Our v0.6.3 SDK already defines `fs/read_text_file`, `fs/write_text_file`, and `session/request_permission` as client methods, so Vibe's bidirectional file ops are supported.

**Optional upgrade path**: The Go SDK main branch tracks schema 0.10.8 (adds `session/fork`, `session/list`, `session/resume`, `session/set_config_option`, `$/cancel_request`) but no new tag has been cut since v0.6.3 (Nov 2025). We can upgrade later for new features; it is **not required** for Vibe integration.

### Authentication

- **Credential**: `MISTRAL_API_KEY` environment variable
- **Obtain from**: [Mistral Console](https://console.mistral.ai/api-keys)
- **Injection mode**: `"env"` (same as Claude Code and Gemini) — inject as env var when starting the agent process
- **No OAuth support** — API key only, which simplifies the integration (no `oauthSupport` field needed in catalog)
- **No credential sync-back** — unlike Codex's file-based OAuth, there's nothing to sync after sessions
- **Key format**: No known prefix convention — validation should be non-empty string only

### Installation in Devcontainers

This is the trickiest part. Unlike Claude Code/Codex/Gemini which are npm packages, Vibe is Python-based (Python 3.12+).

**Recommended approach: Pre-built binary download**

Mistral publishes PyInstaller-bundled standalone `vibe-acp` binaries on [GitHub Releases](https://github.com/mistralai/mistral-vibe/releases) for 6 platforms:
- `vibe-acp-linux-x86_64`, `vibe-acp-linux-aarch64`
- `vibe-acp-darwin-x86_64`, `vibe-acp-darwin-aarch64`
- `vibe-acp-windows-x86_64`, `vibe-acp-windows-aarch64`

These require no Python runtime on the target machine. The install command would be:

```bash
ARCH=$(uname -m) && curl -fLo /usr/local/bin/vibe-acp "https://github.com/mistralai/mistral-vibe/releases/latest/download/vibe-acp-linux-${ARCH}" && chmod +x /usr/local/bin/vibe-acp
```

**Important**: The `installCmd` in the Go agent code currently runs via `docker exec -u root sh -c`, so a curl-based install command should work without modification to `ensureAgentInstalled()`.

**Alternative approaches** (not recommended as primary):
- `pip install mistral-vibe` — requires Python 3.12+ which many devcontainers lack
- `curl -LsSf https://mistral.ai/vibe/install.sh | bash` — installs full CLI, may require Python
- `uv tool install mistral-vibe` — requires installing `uv` first

### Configuration for Headless/ACP Mode

Vibe reads config from `~/.vibe/config.toml` (or `./.vibe/config.toml` per-project). The config directory can be overridden with `VIBE_HOME` env var. For ACP mode (`vibe-acp`), the agent runs as a headless JSON-RPC server over stdin/stdout, so most interactive configuration is irrelevant.

**Key configuration considerations for SAM:**

1. **Tool permissions**: Vibe supports auto-approve via config:
   ```toml
   [tools]
   permission = "always"
   ```
   In ACP mode, tool permissions are handled by the ACP client (SAM's VM agent), so this config may be unnecessary. Needs verification during implementation.

2. **Model selection**: Can be configured via:
   - `active_model` field in `config.toml` (e.g., `active_model = "devstral-2"`)
   - All top-level config fields can be set via `VIBE_*`-prefixed env vars — so `VIBE_ACTIVE_MODEL=devstral-2` should work (needs verification)
   - Available models: `devstral-2` (alias for `devstral-large-2501`, 123B), `devstral-small-2501` (24B)

3. **Telemetry**: Can be disabled via `enable_telemetry = false` in config or `VIBE_ENABLE_TELEMETRY=false` env var. Should be set for SAM-hosted agents.

### CLI Reference (for debugging/fallback)

The full `vibe` CLI (not `vibe-acp`) supports non-interactive execution:

```
vibe [-p TEXT] [--auto-approve] [--max-turns N] [--max-price DOLLARS]
     [--output {text,json,streaming}] [--agent NAME] [--workdir DIR] [PROMPT]
```

Key flags:
- `-p TEXT` / `--prompt TEXT`: Non-interactive/headless mode — send prompt, auto-approve, output, exit
- `--auto-approve`: Skip all tool execution confirmations
- `--max-turns N`: Limit assistant turns (programmatic mode only)
- `--max-price DOLLARS`: Cost limit in USD (programmatic mode only)
- `--output {text,json,streaming}`: Output format
- `--workdir DIR`: Set working directory

This is the fallback if ACP mode has issues, but ACP compatibility is confirmed so this shouldn't be needed.

### Comparison with Existing Agent Integrations

| Aspect | Claude Code | Codex | Gemini CLI | **Mistral Vibe** |
|--------|------------|-------|------------|-----------------|
| **Auth types** | API key + OAuth | API key + OAuth (file-based) | API key only | **API key only** |
| **Env var** | `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | `OPENAI_API_KEY` / file inject | `GEMINI_API_KEY` | **`MISTRAL_API_KEY`** |
| **ACP binary** | `claude-agent-acp` | `codex-acp` | `gemini` | **`vibe-acp`** |
| **ACP args** | none | none | `--experimental-acp` | **none** |
| **Install method** | npm | npm | npm | **Binary download** |
| **Credential sync** | No | Yes (auth.json) | No | **No** |
| **Runtime dep** | Node.js | Node.js | Node.js | **None (standalone binary)** |

## Implementation Checklist

### Phase 1: Shared Types (`packages/shared/src/agents.ts`)

- [ ] Add `'mistral-vibe'` to `AgentType` union type (line 6)
- [ ] Add `'mistral'` to `AgentProvider` union type (line 9)
- [ ] Add Mistral Vibe entry to `AGENT_CATALOG` array:

```typescript
{
  id: 'mistral-vibe',
  name: 'Mistral Vibe',
  description: "Mistral AI's coding agent",
  provider: 'mistral',
  envVarName: 'MISTRAL_API_KEY',
  acpCommand: 'vibe-acp',
  acpArgs: [],
  supportsAcp: true,
  credentialHelpUrl: 'https://console.mistral.ai/api-keys',
  installCommand: 'ARCH=$(uname -m) && curl -fLo /usr/local/bin/vibe-acp "https://github.com/mistralai/mistral-vibe/releases/latest/download/vibe-acp-linux-${ARCH}" && chmod +x /usr/local/bin/vibe-acp',
  // No oauthSupport — API key only
},
```

### Phase 2: VM Agent (Go) (`packages/vm-agent/internal/acp/gateway.go`)

- [ ] Add `"mistral-vibe"` case to `getAgentCommandInfo()` (line 613):

```go
case "mistral-vibe":
    return agentCommandInfo{
        command:    "vibe-acp",
        args:       nil,
        envVarName: "MISTRAL_API_KEY",
        installCmd: `ARCH=$(uname -m) && curl -fLo /usr/local/bin/vibe-acp "https://github.com/mistralai/mistral-vibe/releases/latest/download/vibe-acp-linux-${ARCH}" && chmod +x /usr/local/bin/vibe-acp`,
    }
```

- [ ] Add `"mistral-vibe"` case to `getModelEnvVar()` (line 641):

```go
case "mistral-vibe":
    return "VIBE_ACTIVE_MODEL"  // Verify: Vibe uses VIBE_* prefix for config env vars
```

- [ ] Verify `ensureAgentInstalled()` handles non-npm install commands (curl-based download) — it uses `docker exec -u root sh -c` which should work for any shell command
- [ ] Verify `vibe-acp` starts correctly via `docker exec` with env var injection (test in a container)

### Phase 3: Headless Configuration (if needed)

- [ ] Determine if `vibe-acp` requires any pre-configuration for headless ACP mode
- [ ] If needed, pre-write a minimal `~/.vibe/config.toml` via `docker exec` before starting agent:

```toml
enable_telemetry = false

[tools]
permission = "always"
```

- [ ] Set `VIBE_ENABLE_TELEMETRY=false` env var when starting agent to disable telemetry

### Phase 4: API Validation (`apps/api/`)

- [ ] Verify the credential storage/retrieval path works for the new agent type — the generic `credentials` table should handle it with no schema changes needed
- [ ] Verify `validAgentTypes` set in `apps/api/src/routes/workspaces/runtime.ts` includes `'mistral-vibe'` (or uses `isValidAgentType()` from shared package)
- [ ] Add Mistral API key validation to credential save (non-empty string check at minimum)

### Phase 5: Testing

- [ ] Unit tests for new agent catalog entry in shared package
- [ ] Unit test for `getAgentCommandInfo("mistral-vibe", "api-key")` in Go (`gateway_test.go`)
- [ ] Unit test for `getModelEnvVar("mistral-vibe")` in Go
- [ ] Integration test: binary download installs `vibe-acp` in a test container
- [ ] Capability test: end-to-end ACP session with vibe-acp (Initialize → NewSession → Prompt)
- [ ] Verify UI renders Mistral Vibe card correctly in agent selection (no UI code changes expected — catalog-driven)

### Phase 6: Documentation

- [ ] Update CLAUDE.md if agent list is mentioned
- [ ] Update any agent-related docs in `docs/`

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `vibe-acp` binary not available for target arch | Medium | Verify GitHub releases include linux-x86_64 and linux-aarch64. Fall back to pip install if binary unavailable |
| Binary download URL changes across releases | Low | Pin to `/releases/latest/download/` which auto-redirects. Consider caching in R2 alongside vm-agent binary |
| Headless mode requires pre-configured config.toml | Low | Write minimal config via `docker exec` before starting agent, similar to Codex auth file injection pattern |
| `vibe-acp` binary is larger than npm-installed agents | Low | PyInstaller bundles are typically 50-150MB. First-launch install will be slower. Consider R2 caching |
| `ensureAgentInstalled()` assumes npm-style install | Low | The function runs `docker exec -u root sh -c <installCmd>` — any valid shell command works. Verify the curl command produces a working `/usr/local/bin/vibe-acp` binary |

**Previously flagged risk (resolved):** ACP protocol version mismatch is NOT a concern. Both SAM (v0.6.3) and Vibe (v0.8.0) use protocol version `1`. The `fs/*` client methods are already defined in our SDK version.

## Resolved Open Questions

1. **Does `vibe-acp` accept env var for model selection?** — Yes, Vibe supports `VIBE_*`-prefixed env vars for all top-level config fields. Use `VIBE_ACTIVE_MODEL=devstral-2` for model override. Verify during implementation.

2. **Should we cache `vibe-acp` binaries in R2?** — Recommended for reliability (GitHub rate limits, release URL stability), but not required for initial integration. Can be added as a follow-up.

3. **Is there a `--no-permission-prompt` flag for vibe-acp?** — In ACP mode, tool permissions are handled by the ACP client (SAM's VM agent), not by Vibe itself. The `vibe-acp` binary is a headless JSON-RPC server — it doesn't prompt for permissions. For the full `vibe` CLI, `--auto-approve` or `[tools] permission = "always"` in config handles this.

4. **Optional: upgrade `acp-go-sdk`?** — Main branch tracks schema 0.10.8 with new methods. No new tag yet. Worth upgrading independently of Vibe integration.

## Acceptance Criteria

- [ ] Users can see "Mistral Vibe" in the agent selector in Settings
- [ ] Users can save a Mistral API key in the credentials UI
- [ ] The masked key displays correctly after saving
- [ ] Selecting Mistral Vibe as the active agent starts `vibe-acp` in the devcontainer via ACP
- [ ] Chat messages stream correctly through the existing WebSocket → ACP pipeline
- [ ] Session resumption (LoadSession) works on reconnect
- [ ] Task-driven autonomous execution works with Vibe as the agent
- [ ] Agent auto-installs on first use (binary download) without requiring Python in the container
- [ ] Model override via agent settings works

## Exact Code Changes Required

### 1. `packages/shared/src/agents.ts` — 3 changes

**Line 6** — Add to AgentType union:
```typescript
export type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'mistral-vibe';
```

**Line 9** — Add to AgentProvider union:
```typescript
export type AgentProvider = 'anthropic' | 'openai' | 'google' | 'mistral';
```

**After line 99** — Add catalog entry (before `] as const`):
```typescript
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description: "Mistral AI's coding agent",
    provider: 'mistral',
    envVarName: 'MISTRAL_API_KEY',
    acpCommand: 'vibe-acp',
    acpArgs: [],
    supportsAcp: true,
    credentialHelpUrl: 'https://console.mistral.ai/api-keys',
    installCommand: 'ARCH=$(uname -m) && curl -fLo /usr/local/bin/vibe-acp "https://github.com/mistralai/mistral-vibe/releases/latest/download/vibe-acp-linux-${ARCH}" && chmod +x /usr/local/bin/vibe-acp',
  },
```

### 2. `packages/vm-agent/internal/acp/gateway.go` — 2 changes

**In `getAgentCommandInfo()` switch** — Add case before `default`:
```go
case "mistral-vibe":
    return agentCommandInfo{"vibe-acp", nil, "MISTRAL_API_KEY",
        `ARCH=$(uname -m) && curl -fLo /usr/local/bin/vibe-acp "https://github.com/mistralai/mistral-vibe/releases/latest/download/vibe-acp-linux-${ARCH}" && chmod +x /usr/local/bin/vibe-acp`,
        "", ""}
```

**In `getModelEnvVar()` switch** — Add case before `default`:
```go
case "mistral-vibe":
    return "VIBE_ACTIVE_MODEL"
```

### 3. No database migration needed

The `credentials` and `agentSettings` tables are generic — they store `agentType` as a text field. No schema changes required.

### 4. No API route changes needed

The agent key endpoint (`/api/workspaces/:id/agent-key`) and credential endpoints use `isValidAgentType()` from the shared package, which reads from `AGENT_CATALOG`. Adding to the catalog automatically makes the new type valid everywhere.

### 5. No UI changes needed

The agent settings UI (`AgentKeysSection.tsx`) and chat interface (`ChatSession.tsx`) fetch the agent list from `GET /api/agents`, which reads from `AGENT_CATALOG`. Mistral Vibe will appear automatically in all agent selection UIs once added to the catalog.

## References

- [Mistral Vibe Product Page](https://mistral.ai/products/vibe)
- [GitHub Repository](https://github.com/mistralai/mistral-vibe) (Apache 2.0, 3.2k stars)
- [Official Docs — Introduction](https://docs.mistral.ai/mistral-vibe/introduction)
- [Official Docs — Install](https://docs.mistral.ai/mistral-vibe/introduction/install)
- [Official Docs — Configuration](https://docs.mistral.ai/mistral-vibe/introduction/configuration)
- [Official Docs — Quickstart](https://docs.mistral.ai/mistral-vibe/introduction/quickstart)
- [ACP Setup Guide](https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md)
- [vibe-acp Architecture (DeepWiki)](https://deepwiki.com/mistralai/mistral-vibe/3.2-agent-control-plane-(vibe-acp))
- [Zed ACP Agent Page](https://zed.dev/acp/agent/mistral-vibe)
- [Devstral 2 + Vibe CLI Announcement](https://mistral.ai/news/devstral-2-vibe-cli)
- [Vibe 2.0 Announcement](https://mistral.ai/news/mistral-vibe-2-0)
- [PyPI — mistral-vibe](https://pypi.org/project/mistral-vibe/) (current version 2.4.0)
- [Mistral Vibe Help Center](https://help.mistral.ai/en/articles/496007-get-started-with-mistral-vibe)
