# Expose Platform OpenCode In Project Chat

## Problem

Project Chat hides OpenCode from the agent selector when a user lacks a dedicated OpenCode key or Scaleway cloud credential, even though the workspace runtime can launch OpenCode through the platform AI proxy. The `/api/agents` catalog reports OpenCode as unconfigured, and the UI filters agent options to `configured && supportsAcp`.

## Research Findings

- `apps/api/src/routes/agents-catalog.ts` currently computes `configured` from dedicated agent credentials plus the Scaleway cloud fallback only.
- `apps/api/src/routes/workspaces/runtime.ts` resolves runtime credentials in this order: dedicated/project/user agent key, Scaleway cloud fallback, then AI proxy platform fallback when proxy is enabled.
- `apps/api/src/services/platform-trial.ts` already encodes platform availability as AI proxy enabled plus platform infrastructure credential available, including the existing decryption failure semantics.
- `packages/shared/src/agents.ts` exposes `AgentInfo.fallbackCredentialSource` as only `'scaleway-cloud' | null`.
- `apps/web/src/pages/project-chat/useProjectChatState.ts` should work automatically once the catalog marks OpenCode configured.
- `/api/agents` consumers with source-sensitive copy are `apps/web/src/lib/agent-status.ts` and `apps/web/src/components/AgentKeyCard.tsx`.
- Relevant postmortem lesson: credential fallback changes need explicit branch coverage for each resolution path and precedence case.

## Checklist

- [ ] Extract a neutral platform OpenCode availability helper from `platform-trial.ts`.
- [ ] Update `/api/agents` to mark OpenCode configured when the platform path is available.
- [ ] Extend `AgentInfo.fallbackCredentialSource` with `platform-opencode`.
- [ ] Preserve precedence: dedicated key > Scaleway cloud > platform OpenCode.
- [ ] Update source-sensitive UI status/copy so platform-backed availability does not imply a user-owned key.
- [ ] Add API tests for dedicated, Scaleway, platform-only, unavailable, and precedence cases.
- [ ] Add Project Chat unit coverage showing platform OpenCode appears when the catalog returns it configured.
- [ ] Run focused quality checks.

## Acceptance Criteria

- [ ] `/api/agents` marks OpenCode configured when platform OpenCode is genuinely available.
- [ ] Project Chat shows OpenCode whenever the catalog returns it configured through the platform path.
- [ ] Users with other explicit agent credentials still see OpenCode if platform OpenCode is available.
- [ ] Catalog precedence matches runtime precedence.
- [ ] No non-OpenCode agent is affected by the new platform logic.
- [ ] UI copy does not falsely imply a user-owned key for platform-backed OpenCode.
- [ ] Scaleway fallback and runtime platform fallback behavior remain intact.
- [ ] Unit tests cover the key configuration and precedence combinations.

## References

- Idea: `01KPWKTVEWVYY5K44V3W3SQH8X`
- `apps/api/src/routes/agents-catalog.ts`
- `apps/api/src/routes/workspaces/runtime.ts`
- `apps/api/src/services/platform-trial.ts`
- `packages/shared/src/agents.ts`
- `apps/web/src/pages/project-chat/useProjectChatState.ts`
