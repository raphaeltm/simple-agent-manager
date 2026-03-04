# Integrate Mistral Vibe as a Fourth Agent Type

**Created**: 2026-03-04
**Priority**: Medium
**Effort**: Small-Medium (1-2 sessions)

## Context

[Mistral Vibe](https://mistral.ai/products/vibe) is Mistral AI's terminal-native coding agent, powered by the Devstral 2 model family. It is [open source (Apache 2.0)](https://github.com/mistralai/mistral-vibe) and provides an ACP-compatible binary (`vibe-acp`) that communicates over stdin/stdout JSON-RPC — the same protocol SAM already uses for Claude Code, Codex, and Gemini CLI.

Adding Vibe as a fourth agent gives users access to Mistral's models (Devstral 2) through SAM's existing agent infrastructure with minimal new code.

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
- **Obtain from**: [Mistral Console](https://console.mistral.ai)
- **Injection mode**: `"env"` (same as Claude Code and Gemini) — straightforward
- **No OAuth support** — API key only, which simplifies the integration (no `oauthSupport` field needed in catalog)
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

**Alternative approaches** (not recommended as primary):
- `pip install mistral-vibe` — requires Python 3.12+ which many devcontainers lack
- `curl -LsSf https://mistral.ai/vibe/install.sh | bash` — installs full CLI, may require Python
- `uv tool install mistral-vibe` — requires installing `uv` first

### Configuration

Vibe reads config from `~/.vibe/config.toml` (or `./.vibe/config.toml` per-project). For headless/autonomous operation in SAM, we likely need to pre-write a minimal config that:
- Sets tool permissions to auto-approve (avoids interactive permission prompts)
- Optionally sets the model (via `active_model` field)

The model can also be configured via the `MISTRAL_MODEL` env var or similar — needs verification.

### Programmatic Fallback

Vibe also supports non-interactive execution without ACP:
```bash
vibe --prompt "task description" --max-turns 50
```
This loses streaming and session management. Not needed given ACP compatibility is confirmed, but useful to know for debugging.

## Implementation Checklist

### Phase 1: Shared Types
- [ ] Add `'mistral-vibe'` to `AgentType` union in `packages/shared/src/agents.ts`
- [ ] Add `'mistral'` to `AgentProvider` union
- [ ] Add Mistral Vibe entry to `AGENT_CATALOG` with:
  - `id: 'mistral-vibe'`
  - `acpCommand: 'vibe-acp'`
  - `envVarName: 'MISTRAL_API_KEY'`
  - `installCommand`: binary download curl command
  - No `oauthSupport` field

### Phase 2: VM Agent (Go)
- [ ] Add `"mistral-vibe"` case to `getAgentCommandInfo()` in `gateway.go`
  - `command: "vibe-acp"`, `injectionMode: "env"`, `envVarName: "MISTRAL_API_KEY"`
  - `installCmd`: curl-based binary download (handle x86_64/aarch64)
- [ ] Add `"mistral-vibe"` case to `getModelEnvVar()` (determine correct env var name)
- [ ] Handle any vibe-acp-specific config file pre-creation if needed for headless mode
- [ ] Verify `ensureAgentInstalled()` works with non-npm binary (curl download) — it runs `docker exec -u root sh -c` so should work

### Phase 3: API (Credential Validation)
- [ ] Add Mistral API key validation to `apps/api/src/services/validation.ts` (non-empty check at minimum)
- [ ] Verify credential storage/retrieval works for new agent type (generic `credentials` table — should need no schema changes)

### Phase 4: Testing
- [ ] Unit tests for new agent catalog entry
- [ ] Unit test for `getAgentCommandInfo("mistral-vibe")` in Go
- [ ] Integration test: install `vibe-acp` binary in a test container
- [ ] Capability test: end-to-end ACP session with vibe-acp (Initialize → NewSession → Prompt)

### Phase 5: Documentation
- [ ] Update CLAUDE.md agent documentation section
- [ ] Update any agent-related docs in `docs/`

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `vibe-acp` binary not available for target arch | Medium | Verify GitHub releases include linux-x86_64 and linux-aarch64. Fall back to pip install if binary unavailable |
| Binary download URL changes across releases | Low | Pin to `/releases/latest/download/` which auto-redirects. Consider caching in R2 alongside vm-agent binary |
| Headless mode requires pre-configured config.toml | Low | Write minimal config via `docker exec` before starting agent, similar to Codex auth file injection |
| Model selection mechanism unclear | Low | Research whether `MISTRAL_MODEL` env var works or if config.toml `active_model` is required |

**Previously flagged risk (resolved):** ACP protocol version mismatch is NOT a concern. Both SAM (v0.6.3) and Vibe (v0.8.0) use protocol version `1`. The `fs/*` client methods are already defined in our SDK version.

## Open Questions

1. **Does `vibe-acp` accept env var for model selection?** Or must it be `active_model` in `config.toml`?
2. **Should we cache `vibe-acp` binaries in R2** alongside the vm-agent binary for reliability?
3. **Is there a `--no-permission-prompt` flag or env var** for vibe-acp to auto-approve all tool use in headless mode?
4. **Optional: upgrade `acp-go-sdk`?** Main branch tracks schema 0.10.8 with new methods (`session/fork`, `session/list`, `$/cancel_request`). No new tag yet. Worth upgrading independently of Vibe integration for all agents.

## Acceptance Criteria

- [ ] Users can select "Mistral Vibe" from the agent dropdown in Settings
- [ ] Users can save a Mistral API key in the credentials UI
- [ ] Selecting Mistral Vibe as the active agent starts `vibe-acp` in the devcontainer via ACP
- [ ] Chat messages stream correctly through the existing WebSocket → ACP pipeline
- [ ] Session resumption (LoadSession) works on reconnect
- [ ] Task-driven autonomous execution works with Vibe as the agent
- [ ] Agent auto-installs on first use (binary download) without requiring Python in the container

## References

- [Mistral Vibe Product Page](https://mistral.ai/products/vibe)
- [GitHub Repository](https://github.com/mistralai/mistral-vibe) (Apache 2.0)
- [Official Docs — Introduction](https://docs.mistral.ai/mistral-vibe/introduction)
- [Official Docs — Install](https://docs.mistral.ai/mistral-vibe/introduction/install)
- [Official Docs — Configuration](https://docs.mistral.ai/mistral-vibe/introduction/configuration)
- [ACP Setup Guide](https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md)
- [vibe-acp Architecture (DeepWiki)](https://deepwiki.com/mistralai/mistral-vibe/3.2-agent-control-plane-(vibe-acp))
- [Zed ACP Agent Page](https://zed.dev/acp/agent/mistral-vibe)
- [Devstral 2 + Vibe CLI Announcement](https://mistral.ai/news/devstral-2-vibe-cli)
- [Vibe 2.0 Announcement](https://mistral.ai/news/mistral-vibe-2-0)
