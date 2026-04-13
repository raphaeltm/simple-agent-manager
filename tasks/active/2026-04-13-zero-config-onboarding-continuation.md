# Zero-Config Onboarding Continuation

## Problem

The previous agent (task 01KP39RW9DAG8H09VJ74CTWS30) implemented Work Stream 1 — the AI inference proxy route on branch `sam/ai-inference-proxy-route-01kp39`. That code was never merged. The remaining work to enable zero-config onboarding includes:

- **Stream 1 integration**: Cherry-pick the AI proxy code into this branch
- **Agent-key platform fallback**: Wire the `/agent-key` endpoint to return proxy credentials when the user has no OpenCode credential but the AI proxy is enabled
- **VM agent env var injection**: Set `OPENCODE_PLATFORM_BASE_URL` and `OPENCODE_PLATFORM_API_KEY` when the platform provider is used
- **Trial status endpoint**: New API endpoint for the frontend to check platform trial availability
- **Onboarding bypass**: Allow trial users to skip agent key and cloud credential steps
- **Task submission gate fix**: Allow task submission when platform credentials are available
- **OpenCode version bump**: 1.4.0 → 1.4.3

## Research Findings

### Already on main (Streams 2 & 3 partially complete)
- `buildOpencodeConfig()` in `gateway.go` handles "platform" provider → generates `{env:OPENCODE_PLATFORM_BASE_URL}` and `{env:OPENCODE_PLATFORM_API_KEY}` config
- `agentSettingsPayload` Go struct has `OpencodeProvider` and `OpencodeBaseURL` fields
- `AgentSessionOverrides` has `opencodeProvider` and `opencodeBaseUrl` fields
- Agent settings schema validates OpenCode provider fields
- Agent settings API route handles OpenCode fields
- AgentSettingsSection UI has OpenCode provider dropdown
- OpenCode provider types (`OPENCODE_PROVIDERS`) defined in shared types

### On branch `sam/ai-inference-proxy-route-01kp39` (Stream 1)
- `apps/api/src/routes/ai-proxy.ts` — OpenAI-compatible `/ai/v1/chat/completions` endpoint
- `apps/api/src/services/ai-token-budget.ts` — KV-based daily per-user token tracking
- `apps/api/src/schemas/ai-proxy.ts` — Zod request validation
- `packages/shared/src/constants/ai-services.ts` — Default constants
- Tests for proxy and budget service

### Missing pieces (the gap)
1. **`/agent-key` endpoint** (runtime.ts:72): Returns 404 when no user credential exists. Needs AI proxy fallback.
2. **VM agent**: `fetchAgentKey()` (session_host.go:2060) only parses `apiKey` and `credentialKind`. Needs to handle platform proxy config.
3. **VM agent env injection**: When `opencodeProvider == "platform"`, needs to set `OPENCODE_PLATFORM_BASE_URL` and `OPENCODE_PLATFORM_API_KEY` env vars.
4. **Onboarding**: `OnboardingWizard.tsx` requires `hasAgent && hasCloud && hasGitHub`. Trial users need bypass.
5. **Task submission gate**: `useProjectChatState.ts` blocks on `!hasCloudCredentials`. Must also accept platform credentials.
6. **Trial status**: No endpoint exists to tell the frontend whether trial mode is available.

## Implementation Checklist

### Phase 1: AI Proxy Integration (Stream 1 cherry-pick)
- [ ] Cherry-pick new files from `sam/ai-inference-proxy-route-01kp39`:
  - `apps/api/src/routes/ai-proxy.ts`
  - `apps/api/src/services/ai-token-budget.ts`
  - `apps/api/src/schemas/ai-proxy.ts`
  - `packages/shared/src/constants/ai-services.ts`
  - Tests: `ai-proxy.test.ts`, `ai-token-budget.test.ts`
- [ ] Add env var declarations to `apps/api/src/env.ts`
- [ ] Mount AI proxy route in `apps/api/src/index.ts`

### Phase 2: Agent-Key Platform Fallback (Worker side)
- [ ] Modify `POST /:id/agent-key` in `runtime.ts` to check `AI_PROXY_ENABLED` when no user credential found
- [ ] Return `inferenceConfig` with proxy URL and `apiKeySource: "callback-token"` for platform OpenCode
- [ ] Return a sentinel `apiKey` so the VM agent doesn't reject the response

### Phase 3: VM Agent Platform Credential Handling
- [ ] Extend `fetchAgentKey()` response struct to include `inferenceConfig` fields
- [ ] When `inferenceConfig.apiKeySource == "callback-token"`, inject `OPENCODE_PLATFORM_API_KEY` = callbackToken
- [ ] Inject `OPENCODE_PLATFORM_BASE_URL` from `inferenceConfig.baseURL`
- [ ] Auto-set `opencodeProvider = "platform"` in settings when inferenceConfig is present

### Phase 4: Trial Status Endpoint
- [ ] Create `apps/api/src/services/platform-trial.ts` — checks platform cloud + AI proxy availability
- [ ] Create `GET /api/trial-status` endpoint returning trial availability + daily usage
- [ ] Add API client function in `apps/web/src/lib/api/`

### Phase 5: Onboarding Bypass
- [ ] Add `StepTrialQuickStart.tsx` component — explains trial, offers "Try it now" CTA
- [ ] Modify `OnboardingWizard.tsx` to detect trial availability and offer quick-start
- [ ] Modify `useProjectChatState.ts` credential gate to accept platform credentials
- [ ] Add `TrialQuotaBar.tsx` component showing daily token usage

### Phase 6: OpenCode Version Bump
- [ ] Update `packages/shared/src/agents.ts`: `opencode-ai@1.4.0` → `opencode-ai@1.4.3`
- [ ] Update test expectations if any

### Phase 7: Tests
- [ ] Unit tests for agent-key platform fallback
- [ ] Unit tests for trial status endpoint
- [ ] Go unit tests for platform credential handling in VM agent
- [ ] Integration test for the full platform flow (agent-key → proxy config)

## Acceptance Criteria

- [ ] New users without API keys can submit a task using platform OpenCode + Workers AI
- [ ] AI proxy correctly rate-limits and tracks token budgets per user
- [ ] Onboarding wizard offers trial quick-start when platform credentials are available
- [ ] Task submission gate does not block when platform cloud credentials exist
- [ ] OpenCode version is 1.4.3
- [ ] All env vars are configurable (no hardcoded values)
- [ ] Existing credential flows (user Scaleway, user custom) still work unchanged

## References

- Idea: 01KP39N383G9SGT0WYS3H65EYJ (full implementation plan)
- Previous task: 01KP39RW9DAG8H09VJ74CTWS30 (Stream 1 completed)
- Previous branch: `sam/ai-inference-proxy-route-01kp39`
- Key files: `runtime.ts`, `session_host.go`, `gateway.go`, `OnboardingWizard.tsx`, `useProjectChatState.ts`
