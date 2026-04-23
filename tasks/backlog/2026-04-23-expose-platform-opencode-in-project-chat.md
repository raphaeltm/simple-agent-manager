# Expose Platform OpenCode In Project Chat

## Problem

Project Chat hides `OpenCode` from the agent selector when the user does not have a dedicated OpenCode credential or a Scaleway cloud fallback, even when the platform OpenCode path is actually available via the admin-configured AI proxy and platform infra.

This creates a mismatch between:

- runtime launch eligibility in `apps/api/src/routes/workspaces/runtime.ts`
- agent availability reported by `apps/api/src/routes/agents-catalog.ts`
- selector visibility in `apps/web/src/pages/project-chat/useProjectChatState.ts`

Observed effect:

- new or trial-style users can still fall into `OpenCode` implicitly through backend defaults
- existing users with other explicit credentials cannot intentionally choose `OpenCode`

## Research Findings

- `apps/api/src/routes/agents-catalog.ts`
  - marks `configured` only for dedicated `agent-api-key` credentials
  - adds one special fallback for Scaleway cloud credentials
  - does not account for platform OpenCode availability
- `apps/api/src/routes/workspaces/runtime.ts`
  - resolves credentials in this order:
    - dedicated user/project credential
    - Scaleway cloud fallback for OpenCode
    - platform AI proxy fallback for OpenCode when `AI_PROXY_ENABLED` is enabled
- `apps/api/src/services/platform-trial.ts`
  - already computes whether platform OpenCode is available based on AI proxy enablement plus platform infra credential availability
- `apps/web/src/pages/project-chat/useProjectChatState.ts`
  - filters dropdown agents to `configured && supportsAcp`
  - separately uses `getTrialStatus()` for task submission gating
  - can submit with no explicit `agentType`, which later falls back to backend defaults
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
  - defaults to `DEFAULT_TASK_AGENT_TYPE || 'opencode'` when no explicit agent type is provided
- Existing tests:
  - runtime platform fallback is already covered in `apps/api/tests/unit/routes/opencode-credential-fallback.test.ts`
  - Project Chat selector behavior is covered in `apps/web/tests/unit/pages/project-chat.test.tsx`

## Implementation Checklist

- [ ] Re-read `.do-state.md` and this task file before each phase transition
- [ ] Introduce a neutral/shared API-side helper for platform OpenCode availability so `/api/agents` and trial logic use the same conditions
- [ ] Update `apps/api/src/routes/agents-catalog.ts` to mark `opencode` as configured when platform OpenCode is available
- [ ] Preserve runtime-aligned precedence in the catalog:
  - dedicated key
  - Scaleway cloud fallback
  - platform OpenCode fallback
- [ ] Extend the shared agent info metadata so the source can represent platform-backed OpenCode
- [ ] Audit frontend consumers of `/api/agents` for any source-label or status-copy regressions
- [ ] Add or update API unit tests covering:
  - dedicated OpenCode key
  - Scaleway fallback
  - platform-only fallback
  - unavailable platform
  - precedence cases
- [ ] Add or update frontend tests proving Project Chat shows `OpenCode` when catalog marks it configured via platform source
- [ ] Run local quality checks relevant during implementation
- [ ] Run full validation suite before PR:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
- [ ] Dispatch required specialist review agents and address all blocking findings
- [ ] Verify on staging:
  - user with explicit non-OpenCode credentials can now explicitly choose `OpenCode`
  - trial-style/new user still sees and can use `OpenCode`
  - existing navigation/settings/regression checks remain healthy
- [ ] Archive the task file only after validation is complete

## Acceptance Criteria

- [ ] `/api/agents` reports `opencode` as configured whenever platform OpenCode is genuinely available to the current user
- [ ] Project Chat shows `OpenCode` in the selector for users who can actually launch it through the platform path
- [ ] Users with other explicit agent credentials still see `OpenCode` when platform OpenCode is available
- [ ] Catalog precedence mirrors runtime precedence: dedicated key > Scaleway cloud > platform fallback
- [ ] No non-OpenCode agent changes behavior because of this fix
- [ ] UI status metadata does not falsely imply a user-owned key when the source is platform-backed
- [ ] Existing Scaleway fallback behavior remains intact
- [ ] Existing runtime platform fallback behavior remains intact
- [ ] Tests cover dedicated, Scaleway, platform-only, unavailable, and precedence scenarios
- [ ] Staging verification confirms explicit `OpenCode` selection works end to end

## References

- `apps/api/src/routes/agents-catalog.ts`
- `apps/api/src/routes/workspaces/runtime.ts`
- `apps/api/src/services/platform-trial.ts`
- `apps/web/src/pages/project-chat/useProjectChatState.ts`
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
- `apps/api/tests/unit/routes/opencode-credential-fallback.test.ts`
- `apps/web/tests/unit/pages/project-chat.test.tsx`
- `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`
- `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`
- `.claude/rules/13-staging-verification.md`
