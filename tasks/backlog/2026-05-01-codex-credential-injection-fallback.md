# WP3: Codex Credential Injection Fallback

## Problem Statement

When no user-provided OpenAI API key exists for Codex (openai-codex agent type), Codex cannot run. We need to inject SAM's AI proxy as the credential source so Codex runs against SAM's platform proxy with zero-key onboarding. This mirrors the Claude Code fallback (WP2, PR #862).

## Research Findings

### Existing Pattern (WP2 — Claude Code)
- `runtime.ts:79` — AI proxy fallback for `opencode` and `claude-code` when no user credential exists
- Returns `inferenceConfig` with `provider: 'anthropic-proxy'` for Claude Code
- `session_host.go:994` — When `agentType == "claude-code"` AND `inferenceConfig.Provider == "anthropic-proxy"`, injects `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
- `gateway.go:432-437` — `inferenceConfig` struct with Provider, BaseURL, Model, APIKeySource fields

### Codex Configuration
- Codex uses `OPENAI_BASE_URL` and `OPENAI_API_KEY` env vars for custom proxy configuration
- Codex sends requests to `OPENAI_BASE_URL/chat/completions` (NOT `OPENAI_BASE_URL/v1/chat/completions`)
- SAM's existing OpenAI-format proxy is at `/ai/v1/chat/completions`
- So `OPENAI_BASE_URL` should be set to `https://api.{BASE_DOMAIN}/ai/v1` — Codex will append `/chat/completions`
- Auth via `Authorization: Bearer <callback-token>` — matches `verifyCallbackToken()` in ai-proxy.ts

### Constants Needed
- Need `DEFAULT_AI_PROXY_OPENAI_MODEL` constant (e.g., `gpt-4.1`) in shared/constants
- Need `AI_PROXY_DEFAULT_OPENAI_MODEL` env var override

### No `fallbackCloudProvider` on openai-codex
- `openai-codex` agent definition has no `fallbackCloudProvider` field, so the Scaleway credential fallback path won't trigger

## Implementation Checklist

- [ ] Add `DEFAULT_AI_PROXY_OPENAI_MODEL` constant to `packages/shared/src/constants/ai-services.ts`
- [ ] Export the new constant from `packages/shared/src/constants/index.ts`
- [ ] Extend `runtime.ts` AI proxy fallback condition to include `openai-codex`
- [ ] Add `openai-proxy` provider branch for `openai-codex` (distinct from `openai-compatible` used by opencode)
- [ ] Add Codex injection branch in `session_host.go` — set `OPENAI_BASE_URL` and `OPENAI_API_KEY`
- [ ] Add model override via `OPENAI_MODEL` env var when inferenceConfig has model
- [ ] Add unit test: `openai-codex` with no credential returns `openai-proxy` inferenceConfig
- [ ] Add unit test: `openai-codex` with user credential returns user credential (no proxy)
- [ ] Add unit test: `openai-codex` with AI proxy disabled returns 404
- [ ] Add unit test: custom model from `AI_PROXY_DEFAULT_OPENAI_MODEL` env var
- [ ] Add unit test: task credential source tracking for codex proxy fallback
- [ ] Update CLAUDE.md recent changes if needed

## Acceptance Criteria

- [ ] When `agentType === 'openai-codex'` and no user credential exists and AI proxy is enabled, the agent-key endpoint returns `inferenceConfig` with `provider: "openai-proxy"`
- [ ] When user credential exists for openai-codex, it takes priority over proxy fallback
- [ ] When AI proxy is disabled, openai-codex with no credential returns 404
- [ ] VM agent correctly injects `OPENAI_BASE_URL` and `OPENAI_API_KEY` when `inferenceConfig.Provider == "openai-proxy"`
- [ ] Existing opencode and claude-code fallback behavior is unchanged
- [ ] All new tests pass

## References

- `apps/api/src/routes/workspaces/runtime.ts` — credential resolution chain
- `packages/vm-agent/internal/acp/session_host.go` — agent credential injection
- `packages/vm-agent/internal/acp/gateway.go` — inferenceConfig struct
- `apps/api/src/routes/ai-proxy.ts` — existing OpenAI-format proxy endpoint
- `packages/shared/src/agents.ts` — agent type definitions
- `packages/shared/src/constants/ai-services.ts` — AI proxy constants
- `apps/api/tests/unit/routes/claude-code-proxy-fallback.test.ts` — test pattern to follow
