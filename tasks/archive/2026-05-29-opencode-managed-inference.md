# Implement OpenCode Managed Inference Support

## Problem

Users should be able to authenticate OpenCode with their own opencode.ai account and use OpenCode managed Zen/Go models. The settings UI/API needs a new OpenCode provider value, and the VM agent must inject the credential under the environment variable OpenCode expects for managed inference.

## Research Findings

- `packages/shared/src/types/agent-settings.ts` is the shared source of truth for `OpenCodeProvider`, `OPENCODE_PROVIDERS`, and dropdown ordering.
- API validation imports `OPENCODE_PROVIDERS`, so adding the provider to shared types updates the accepted values in `apps/api/src/schemas/agent-settings.ts` and DB deserialization in `apps/api/src/routes/agent-settings.ts`.
- `packages/vm-agent/internal/acp/gateway.go` builds `OPENCODE_CONFIG_CONTENT`. Built-in providers (`scaleway`, `anthropic`) currently do not need npm/model registration; custom-like providers do.
- `packages/vm-agent/internal/acp/session_host_startup.go` injects credentials using the agent command default env var. OpenCode defaults to `SCW_SECRET_KEY`, so non-Scaleway OpenCode providers need explicit credential env var mapping.
- `packages/vm-agent/internal/acp/process.go` keeps explicit secret env names to avoid leaking values through docker exec command-line arguments.
- Related credential handling rules: `.claude/rules/06-technical-patterns.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, and staging gate rules in `.claude/rules/13-staging-verification.md`.

## Implementation Checklist

- [x] Add `opencode-managed` to shared OpenCode provider types, metadata, and dropdown order.
- [x] Add VM agent OpenCode config handling for `opencode-managed`, preserving managed model prefixes like `opencode-zen/*` and `opencode-go/*`.
- [x] Map OpenCode credential env vars by selected provider so `opencode-managed`, `anthropic`, `google-vertex`, and custom-compatible providers use the env var referenced by their generated config.
- [x] Add `OPENCODE_API_KEY` to explicit secret env handling.
- [x] Add Go tests for OpenCode managed config and provider-specific credential env injection.
- [x] Run focused TypeScript/Go validation and broader quality checks as feasible.

## Acceptance Criteria

- `opencode-managed` is accepted as an OpenCode provider and appears in provider dropdown ordering.
- OpenCode managed models route through OpenCode built-in Zen/Go prefixes without unnecessary custom provider registration.
- User-provided OpenCode managed credentials are injected as `OPENCODE_API_KEY`, not `SCW_SECRET_KEY`.
- Existing non-Scaleway OpenCode providers receive credentials under the env var referenced by their config.
- Secrets remain passed through env-file handling rather than docker command-line args.
- Focused tests cover the new provider and credential env mapping.
