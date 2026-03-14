# Fix Mistral Vibe ACP Empty Metadata Error

**Status:** backlog
**Priority:** high
**Estimated Effort:** 1-2 hours
**Created:** 2026-03-14

## Problem Statement

When starting an ACP session with the Mistral Vibe agent, the Mistral API rejects requests with:

```
Error: API error from mistral (model: mistral-vibe-cli-latest): {"detail":[{"type":"value_error","loc":["body","metadata"],"msg":"Value error, metadata value cannot be empty","input":{"agent_entrypoint":"acp","agent_version":"2.4.2","client_name":"","client_version":""},"ctx":{"error":{}}}]}
```

The `vibe-acp` binary (v2.4.2, latest as of 2026-03-14) sends empty strings for `client_name` and `client_version` in API request metadata when running in ACP mode. Mistral's API now validates that metadata values are non-empty, causing all Mistral Vibe sessions to fail.

## Root Cause

In ACP (headless) mode, `vibe-acp` has no terminal client to identify, so `client_name` and `client_version` are left as empty strings. The normal CLI entrypoint (`vibe`) populates these fields, but the ACP entrypoint does not. This is a vibe-acp upstream bug.

## Additional Issue: Model Alias vs Model ID

`VIBE_ACTIVE_MODEL` expects a **config alias** (e.g., `devstral-2`), not a raw Mistral API model name (e.g., `mistral-large-2512`). SAM's agent settings UI lets users type raw model IDs, which fail with "Active model not found in configuration." The only alias that works out of the box is `devstral-2`.

## Workaround Options (Investigate in Order)

### Option A: Environment Variable Injection
All top-level `VibeConfig` fields can be set via `VIBE_`-prefixed env vars. If `client_name` is a VibeConfig field, inject `VIBE_CLIENT_NAME=sam` and `VIBE_CLIENT_VERSION=1.0.0` alongside the existing `VIBE_ACTIVE_MODEL` injection in `packages/vm-agent/internal/acp/gateway.go:getModelEnvVar()` or `session_host.go`.

**Risk:** `client_name` may not be a VibeConfig field — it could be set programmatically in the ACP entrypoint, in which case env vars won't override it.

### Option B: Write config.toml on VM
Generate a `~/.vibe/config.toml` via cloud-init or at session start that includes `client_name = "sam"` and `client_version = "1.0.0"`. This also allows pre-configuring model aliases so users can select non-default models like `mistral-large`.

### Option C: Wait for Upstream Fix
Monitor the [mistral-vibe releases](https://github.com/mistralai/mistral-vibe/releases) for a fix. The empty metadata issue is clearly a bug in ACP mode and will likely be patched. However, we should not block on this since we don't control the release timeline.

## Acceptance Criteria

- [ ] Mistral Vibe agent sessions start successfully without metadata validation errors
- [ ] The chosen workaround is implemented and tested on staging with a real Mistral API key
- [ ] If Option B is used, document how to add custom model aliases for non-default models
- [ ] Backlog task filed for improving model selection UX if the alias-vs-ID issue remains

## References

- [Mistral Vibe Configuration Docs](https://docs.mistral.ai/mistral-vibe/introduction/configuration)
- [Mistral Vibe GitHub](https://github.com/mistralai/mistral-vibe)
- [DeepWiki Config Reference](https://deepwiki.com/mistralai/mistral-vibe/8.1-configuration-reference)
- [Reverse-engineered config.toml guide](https://gist.github.com/chris-hatton/6e1a62be8412473633f7ef02d067547d)
