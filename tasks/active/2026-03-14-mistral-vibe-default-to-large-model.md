# Switch Mistral Vibe Default Model to Mistral Large

**Status:** active
**Priority:** medium
**Estimated Effort:** 1 hour
**Created:** 2026-03-14

## Problem Statement

Mistral Vibe's `VIBE_ACTIVE_MODEL` env var expects a **config alias** (e.g., `devstral-2`), not a raw Mistral API model name. The only built-in alias is `devstral-2`, which maps to the code-focused Devstral model. Users wanting to use Mistral's most capable model (Mistral Large) have no way to select it because the alias doesn't exist in the default config.

Additionally, a pre-existing test (`TestGetAgentExtraEnvVars_MistralVibe`) expects `VIBE_CLIENT_VERSION=1.0.0` but the code was bumped to `1.0.1` in commit 8c00611, leaving the test failing.

## Research Findings

- **Model env var**: `VIBE_ACTIVE_MODEL` is the env var for Mistral Vibe (`gateway.go:getModelEnvVar()`)
- **Config file**: `~/.vibe/config.toml` defines `[[models]]` entries with `name` (API model ID), `provider`, `alias`, and `active_model` (which alias to use)
- **Default alias**: Only `devstral-2` is built-in to vibe-acp; other models require config.toml entries
- **Latest large model**: `mistral-large-latest` is the API identifier for Mistral Large 3
- **File injection**: `writeAuthFileToContainer()` in `gateway.go` already handles writing files into containers with proper permissions
- **Existing workaround**: `getAgentExtraEnvVars()` already injects `VIBE_CLIENT_NAME` and `VIBE_CLIENT_VERSION` for the metadata bug

## Implementation Checklist

- [x] Add `generateVibeConfig()` function to `gateway.go` that produces a TOML config with model aliases for mistral-large, devstral-2, and codestral
- [x] Add `writeVibeConfigToContainer()` function that writes the config to `~/.vibe/config.toml`
- [x] Set `vibeDefaultActiveModel = "mistral-large"` as the new default
- [x] Modify `startAgent()` in `session_host.go` to write the config before starting the Mistral Vibe agent
- [x] Fix pre-existing test: update `VIBE_CLIENT_VERSION` expectation from `1.0.0` to `1.0.1`
- [x] Add `TestGenerateVibeConfig_DefaultModel` and `TestGenerateVibeConfig_CustomModel` tests
- [x] Verify all Go tests pass

## Acceptance Criteria

- [x] Default Mistral Vibe sessions use Mistral Large (`mistral-large-latest`) instead of Devstral 2
- [x] Users can still select `devstral-2` or `codestral` via agent settings model override
- [x] Config.toml is written to the container before the agent process starts
- [x] All Go tests pass, including new tests for config generation
- [x] Pre-existing test version mismatch is fixed

## References

- `packages/vm-agent/internal/acp/gateway.go` — model env var mapping, config generation
- `packages/vm-agent/internal/acp/session_host.go` — agent startup flow
- `tasks/active/2026-03-14-fix-mistral-vibe-acp-metadata.md` — related metadata fix task
- [Mistral Models Documentation](https://docs.mistral.ai/getting-started/models/)
