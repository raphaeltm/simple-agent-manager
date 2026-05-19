# Explicit SAM Provider Selection for Claude Code and Codex

## Problem

Claude Code and Codex currently receive SAM-managed platform AI implicitly when no user credential exists and `AI_PROXY_ENABLED` is not false. That makes fresh users silently eligible for platform-paid AI. Users must explicitly opt in by selecting `SAM` as the provider for Claude Code and/or Codex, see quota/billing context, and remain able to use direct user credentials and Claude Code OAuth without proxying OAuth.

This work also needs the minimum quota-aware enforcement required for SAM-provider traffic: admin-granted allowance ceilings, user self-limits bounded by those ceilings, daily token caps, and monthly USD cost caps.

## Research Findings

- Idea `01KQG61Y8H4WFR7WK152S7CM0S` defines the current product contract and acceptance criteria. Related idea `01KRX9BW3RWPVQ9M4AAH46NJ99` calls out monthly cost cap enforcement and token accounting reliability.
- `apps/api/src/routes/workspaces/runtime.ts` currently has implicit platform proxy fallback for `opencode`, `claude-code`, and `openai-codex` whenever no credential is found and the proxy is enabled.
- `apps/api/src/routes/agents-catalog.ts` only exposes platform availability for OpenCode. Claude Code and Codex are not marked configured through explicit provider choice today.
- `apps/api/src/routes/agent-settings.ts`, `apps/api/src/schemas/agent-settings.ts`, `packages/shared/src/types/agent-settings.ts`, and `apps/api/src/db/schema.ts` already provide user-scoped per-agent settings. Existing OpenCode provider fields in `agent_settings` are the closest storage pattern.
- User and project agent credential resolution is implemented in `apps/api/src/routes/credentials.ts` and `getDecryptedAgentKey()`. Project-scoped credentials must keep overriding user settings where they exist.
- `apps/web/src/components/AgentSettingsCard.tsx`, `AgentKeyCard.tsx`, `AgentCard.tsx`, and `apps/web/src/lib/agent-status.ts` are the user-facing connection/configuration surfaces. `apps/web/src/pages/workspace/useSessionState.ts` filters available chat/session agents from `/api/agents`.
- `apps/api/src/services/ai-token-budget.ts` stores user self-limits in KV and checks daily token budget. It currently validates user limits only against environment maximums, not per-user admin ceilings.
- `apps/api/src/routes/usage.ts` returns user AI budget and writes user budget settings. It aggregates monthly cost from AI Gateway logs but does not enforce monthly caps.
- `apps/api/src/routes/ai-proxy.ts`, `ai-proxy-anthropic.ts`, and `ai-proxy-passthrough.ts` check daily token budget before forwarding, and use `attach*TokenUsageAccounting()` after successful responses. Monthly cost caps need to gate SAM-provider traffic before forwarding.
- `apps/api/src/services/ai-proxy-shared.ts` builds AI Gateway metadata with `userId`, `workspaceId`, `projectId`, `trialId`, and model fields. Attribution metadata already exists and should be preserved.
- `packages/vm-agent/internal/acp/session_host_startup.go` already injects callback-token proxy env vars when `apiKeySource === "callback-token"`. Preserve that contract.
- Relevant post-mortems:
  - `2026-04-18-project-credentials-security-hardening-postmortem.md`: credential fallback branches need behavioral tests, not source-contract tests.
  - `2026-03-12-callback-auth-middleware-leak-postmortem.md`: workspace callback routes must be tested through combined routing and not accidentally protected by session middleware.
  - `2026-03-30-duplicate-settings-controls-postmortem.md`: settings UI changes must consolidate existing controls instead of adding duplicate surfaces.

## Implementation Checklist

- [ ] Add explicit provider mode to agent settings for Claude Code and Codex, with validation and migration.
- [ ] Add provider-mode resolution helpers that preserve project/user credentials, passthrough proxy for user API keys, direct Claude Code OAuth injection, and SAM-only platform fallback.
- [ ] Update `/api/agents` and frontend status helpers so Claude Code/Codex are configured only by credentials/OAuth or explicit `SAM` provider mode.
- [ ] Update agent settings UI to select `SAM` for Claude Code and Codex and show quota/billing/free-tier allowance context.
- [ ] Add admin AI allowance ceilings per user and enforce user self-limit updates against effective admin ceilings.
- [ ] Add monthly USD cost cap enforcement for SAM-provider AI proxy traffic while preserving daily token caps.
- [ ] Preserve AI Gateway attribution metadata for user/workspace/project traffic.
- [ ] Add focused unit tests for provider-mode resolution, no-silent-fallback behavior, frontend availability, quota ceiling validation, and cost-cap enforcement.
- [ ] Add or run Playwright visual audit for the changed settings surface.
- [ ] Update docs/self-hosting and recent changes for new setup expectations.
- [ ] Run specialist validation: env-validator, constitution-validator, security-auditor, doc-sync-validator, plus task-completion-validator and relevant UI/API reviewers.

## Acceptance Criteria

- [ ] A brand-new user with no AI credentials does not see Claude Code/Codex as configured until they select SAM as provider.
- [ ] After selecting SAM as provider, the user can start Claude Code and Codex sessions without provider credentials.
- [ ] The session routes through SAM proxy using workspace callback token, not raw platform provider secrets in the workspace.
- [ ] Claude Code OAuth credentials still bypass proxy and continue working.
- [ ] User sees free-tier AI allowance and current usage before/after enabling SAM provider.
- [ ] Admin can grant a higher AI allowance ceiling to a user.
- [ ] User can set lower self-limits but cannot exceed the admin ceiling.
- [ ] Monthly cost cap and daily token caps are enforced for SAM-provider AI proxy traffic.
- [ ] Gateway usage remains attributable by user/workspace/project metadata.

## References

- idea:01KQG61Y8H4WFR7WK152S7CM0S
- idea:01KRX9BW3RWPVQ9M4AAH46NJ99
- `apps/api/src/routes/workspaces/runtime.ts`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `apps/api/src/routes/ai-proxy.ts`
- `apps/api/src/routes/ai-proxy-anthropic.ts`
- `apps/api/src/routes/ai-proxy-passthrough.ts`
- `apps/api/src/services/ai-token-budget.ts`
- `apps/api/src/routes/usage.ts`
- `apps/api/src/routes/agents-catalog.ts`
- `apps/web/src/pages/workspace/useSessionState.ts`
- `apps/web/src/lib/agent-status.ts`
