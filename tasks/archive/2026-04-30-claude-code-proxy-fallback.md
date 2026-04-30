# Claude Code AI Proxy Credential Fallback

## Problem

When a user has no Anthropic API key configured, Claude Code agent sessions cannot start. The platform already has an AI proxy (PR #859) that provides native Anthropic-format pass-through to Cloudflare AI Gateway. We need to extend the credential fallback chain so Claude Code sessions automatically use the platform proxy when no user credential exists — enabling zero-key onboarding.

The same pattern already exists for OpenCode (openai-compatible proxy fallback). This task extends it to Claude Code with Anthropic-native proxy format.

## Research Findings

### Control Plane (`runtime.ts`)
- `POST /:id/agent-key` resolves credentials: user project-scoped → user global → platform credential
- Lines 78-120: AI proxy fallback ONLY for `agentType === 'opencode'`
- Returns `inferenceConfig` with `provider: 'openai-compatible'`, `baseURL`, `model`, `apiKeySource: 'callback-token'`
- Need to add parallel branch for `agentType === 'claude-code'`
- Base URL for Anthropic proxy: `https://api.{BASE_DOMAIN}/ai/anthropic` (Claude Code appends `/v1/messages`)

### VM Agent (`session_host.go`)
- Lines 988-1011: Platform proxy injection only handles OpenCode env vars (`OPENCODE_PLATFORM_BASE_URL`, `OPENCODE_PLATFORM_API_KEY`)
- Need to add branch for `claude-code` + `anthropic-proxy` provider to inject `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_AUTH_TOKEN` is the correct env var for Claude Code custom proxy (not `ANTHROPIC_API_KEY`)
- Must NOT set `ANTHROPIC_API_KEY` when using proxy mode (would conflict)

### Anthropic Proxy (`ai-proxy-anthropic.ts`)
- Mounted at `/ai/anthropic/v1` in index.ts
- Auth via `x-api-key` header (which Claude Code sends as `ANTHROPIC_AUTH_TOKEN`)
- Uses `verifyCallbackToken()` to validate workspace callback tokens
- Streams responses via SSE pass-through

### Agent Catalog (`agents.ts`)
- Claude Code definition has `envVarName: 'ANTHROPIC_API_KEY'` and `provider: 'anthropic'`
- OAuth support uses `CLAUDE_CODE_OAUTH_TOKEN`
- No `fallbackCloudProvider` set (correct — this is an inference proxy, not a cloud credential)

### Gateway Types (`gateway.go`)
- `inferenceConfig` struct already supports: `Provider`, `BaseURL`, `Model`, `APIKeySource`
- `agentCredential` struct has `inferenceConfig *inferenceConfig` field
- No changes needed to the struct — just needs new provider value `"anthropic-proxy"`

### `getAgentCommandInfo()` (`gateway.go`)
- For `claude-code` with API key: sets `envVarName = "ANTHROPIC_API_KEY"`
- For `claude-code` with OAuth: sets `envVarName = "CLAUDE_CODE_OAUTH_TOKEN"`
- When using proxy mode, we skip the normal `envVarName` injection entirely (same pattern as OpenCode)

## Implementation Checklist

- [ ] 1. Extend `runtime.ts` AI proxy fallback to include `claude-code` agent type
  - Add `|| body.agentType === 'claude-code'` to the proxy fallback condition
  - Use `baseURL: https://api.${baseDomain}/ai/anthropic` (not `/ai/v1`)
  - Use `provider: 'anthropic-proxy'` to distinguish from OpenCode's `openai-compatible`
  - Use `model: 'claude-sonnet-4-6'` as default (configurable via env/KV)
  - Return same `apiKey: '__platform_proxy__'`, `credentialSource: 'platform'`, `apiKeySource: 'callback-token'`
- [ ] 2. Extend `session_host.go` platform proxy injection for Claude Code
  - In the `cred.inferenceConfig != nil && apiKeySource == "callback-token"` block
  - Add check: if `agentType == "claude-code"` AND `inferenceConfig.Provider == "anthropic-proxy"`
  - Set `ANTHROPIC_BASE_URL` = inferenceConfig.BaseURL
  - Set `ANTHROPIC_AUTH_TOKEN` = workspace callback token
  - Ensure `ANTHROPIC_API_KEY` is NOT set (skip normal `info.envVarName` injection)
  - Keep existing OpenCode handling for `openai-compatible` provider
- [ ] 3. Add default model env var for Claude Code proxy (`AI_PROXY_DEFAULT_ANTHROPIC_MODEL`)
  - Add constant to shared package
  - Default to `claude-sonnet-4-6`
  - Use in `runtime.ts` fallback
- [ ] 4. Write API tests for credential resolution
  - Test: `claude-code` + no user credential + AI proxy enabled → returns inferenceConfig with `anthropic-proxy`
  - Test: `claude-code` + user credential exists → returns user credential (no proxy fallback)
  - Test: `claude-code` + AI proxy disabled → returns 404 (no credential)
- [ ] 5. Write VM agent tests for env var injection
  - Test: `inferenceConfig.Provider == "anthropic-proxy"` → `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` set
  - Test: `ANTHROPIC_API_KEY` NOT set when using proxy mode
  - Test: OpenCode proxy still works (no regression)
- [ ] 6. Add `ANTHROPIC_AUTH_TOKEN` to the sensitive env var filter in `process.go`
- [ ] 7. Update CLAUDE.md with the new credential injection path in Recent Changes

## Acceptance Criteria

- [ ] When `agentType === 'claude-code'` and no user credential exists, the `/agent-key` endpoint returns `inferenceConfig` with `provider: "anthropic-proxy"` and correct base URL
- [ ] When `agentType === 'claude-code'` and a user credential EXISTS, the endpoint returns the user credential (no proxy fallback)
- [ ] When AI proxy is disabled, Claude Code without credential returns 404
- [ ] VM agent sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for anthropic-proxy provider
- [ ] VM agent does NOT set `ANTHROPIC_API_KEY` when using proxy mode
- [ ] Existing OpenCode proxy fallback is unaffected (no regression)
- [ ] `ANTHROPIC_AUTH_TOKEN` is filtered from process env var logging
- [ ] All new code paths have test coverage

## References

- `apps/api/src/routes/workspaces/runtime.ts` — credential resolution chain
- `packages/vm-agent/internal/acp/session_host.go` — agent credential injection
- `packages/vm-agent/internal/acp/gateway.go` — inferenceConfig struct, getAgentCommandInfo
- `apps/api/src/routes/ai-proxy-anthropic.ts` — Anthropic proxy endpoint
- `packages/shared/src/agents.ts` — agent type definitions
- `packages/vm-agent/internal/acp/process.go` — sensitive env var filter
