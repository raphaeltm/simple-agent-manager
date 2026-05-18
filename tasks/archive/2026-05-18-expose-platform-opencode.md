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

- [x] Extract a neutral platform OpenCode availability helper from `platform-trial.ts`.
- [x] Update `/api/agents` to mark OpenCode configured when the platform path is available.
- [x] Extend `AgentInfo.fallbackCredentialSource` with `platform-opencode`.
- [x] Preserve precedence: dedicated key > Scaleway cloud > platform OpenCode.
- [x] Update source-sensitive UI status/copy so platform-backed availability does not imply a user-owned key.
- [x] Add API tests for dedicated, Scaleway, platform-only, unavailable, and precedence cases.
- [x] Add Project Chat unit coverage showing platform OpenCode appears when the catalog returns it configured.
- [x] Run focused quality checks.

## Acceptance Criteria

- [x] `/api/agents` marks OpenCode configured when platform OpenCode is genuinely available.
- [x] Project Chat shows OpenCode whenever the catalog returns it configured through the platform path.
- [x] Users with other explicit agent credentials still see OpenCode if platform OpenCode is available.
- [x] Catalog precedence matches runtime precedence.
- [x] No non-OpenCode agent is affected by the new platform logic.
- [x] UI copy does not falsely imply a user-owned key for platform-backed OpenCode.
- [x] Scaleway fallback and runtime platform fallback behavior remain intact.
- [x] Unit tests cover the key configuration and precedence combinations.

## References

- Idea: `01KPWKTVEWVYY5K44V3W3SQH8X`
- `apps/api/src/routes/agents-catalog.ts`
- `apps/api/src/routes/workspaces/runtime.ts`
- `apps/api/src/services/platform-trial.ts`
- `packages/shared/src/agents.ts`
- `apps/web/src/pages/project-chat/useProjectChatState.ts`

## Completion Notes

- Shared platform OpenCode availability logic was extracted from `platform-trial.ts`.
- `/api/agents` now marks OpenCode configured through the platform proxy path when no higher-precedence credential path applies.
- `AgentInfo.fallbackCredentialSource` now supports `platform-opencode`.
- Source-sensitive web status/copy treats platform-backed OpenCode as platform availability, not a user-owned key.
- Task completion validation and specialist reviews found no blocking gaps.
- The archived task record documents the `AgentInfo` source metadata change for PR preflight evidence.

## Validation

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/agents-catalog.test.ts`
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/pages/project-chat.test.tsx tests/unit/components/agent-card.test.tsx`
- `pnpm --dir apps/web exec playwright test tests/playwright/agent-settings-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)'`
