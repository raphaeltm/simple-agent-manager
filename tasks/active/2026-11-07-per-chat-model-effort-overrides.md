# Per-chat model and effort overrides in the new-chat composer

## Problem

The new-chat composer's **Chat options** panel (sliders button) lets a person override the
skill and resources for one chat, but not the model or effort. To try a different model or
effort level for a single chat, they must edit the profile (changing it for everyone) or make
a new profile. Raphaël (2026-11-07, task 01M6V1ZT57C7AR0GE2WW3DEMSH): "I think that UI should
allow you to override things like the model and effort as well."

## Research Findings

- UI: `apps/web/src/components/project-chat/profile-picker/ComposerOptions.tsx` renders the panel
  (`SkillSelector` + `ResourceRequirementsInput`, "Leave blank to use the profile's").
  `composerOptionsCount` drives the badge. Wired through `pages/project-chat/ChatInput.tsx`,
  `pages/project-chat/index.tsx`, state in `pages/project-chat/useProjectChatState.ts` (725 lines,
  over the 500-line limit: new state must go in an extracted hook, not grow this file).
- Submit has two paths in `useProjectChatState.handleSubmit`:
  - Instant (`selectedRuntime === 'cf-container'`): `startInstantChatSession` →
    `POST /api/projects/:id/sessions/start` → `apps/api/src/routes/chat-start.ts`, which builds
    `overrides: { model: resolvedProfile?.model, effort: resolvedProfile?.effort }`.
  - VM: `buildBaseSubmitRequest` (`pages/project-chat/submitRequest.ts`) → `submitTask` →
    `POST /api/projects/:id/tasks/submit` → `services/submit-task-implementation.ts`, which sets
    `model: resolvedProfile?.model ?? projectAgentDefaults.model`, `effort: resolvedProfile?.effort`
    on the TaskRunner config. If the profile resolves to Instant there, it delegates to
    `services/submit-instant-task.ts` (`overrides: { model: profile?.model ?? defaults.model, ... }`).
- Neither `SubmitTaskSchema` (`schemas/tasks.ts`) nor `StartChatSessionSchema` (`schemas/misc.ts`)
  accepts `model`/`effort`; shared `SubmitTaskRequest` (`packages/shared/src/types/task.ts`) and web
  `StartInstantChatSessionRequest` (`lib/api/sessions.ts`) lack them.
- Resolution precedence today: skill → profile → project agent default (`resolveSkillProfile`,
  `services/skills.ts`). The skill drops an effort its resolved agent cannot run.
- Durability: the launch `overrides` are frozen into `agent_sessions.runtime_contract_json`
  (`startSamAwareAgentSession`, `services/agent-session-bootstrap.ts`) and session snapshots; recovery
  (`services/session-recovery-task.ts`) and wake read that contract, so a per-chat override survives
  restart/sleep without extra storage.
- Effort validation exists per agent type: `isAgentEffortSupported` / `getSupportedEffortsForAgent`
  (`packages/shared/src/types/agent-settings.ts`); profiles validate with the private
  `validateProfileEffort` in `services/agent-profiles.ts`. Reuse it (rule 24), don't fork it.
- Model is free-form on profiles (`ModelSelect` "Select or type a model..."). Agent-settings bounds
  model length to 200 (`AGENT_SETTINGS_VALIDATION_DEFAULTS.maxModelLength`).
- `ModelSelect` (`components/ModelSelect.tsx`) already has a "No override" option and accepts
  `agentType`. Profile form effort uses `SelectField` with `getSupportedEffortsForAgent`.
- Effective agent type for UI = `skill.agentType || profile.agentType` (same as the server).
  Overrides chosen for one agent type are meaningless for another (Codex model on a Claude
  profile), so they must not leak across a profile/skill switch that changes the agent.
- Docs: `apps/www/src/content/docs/docs/guides/agents.md:484` and `concepts.mdx:102` describe what
  Chat options contains.

## Implementation Checklist

- [x] Shared: add `model?: string | null` and `effort?: AgentEffort | null` to `SubmitTaskRequest`
- [x] API schemas: add bounded `model` and `effort` to `SubmitTaskSchema` and `StartChatSessionSchema`
- [x] API: one helper that normalizes request overrides and validates effort against the resolved
      agent type (reusing the profile effort validator), called in all three launch paths before any
      task effects
- [x] API VM path (`submit-task-implementation.ts`): explicit > skill/profile > project default
- [x] API Instant via submit (`submit-instant-task.ts`) and via chat-start (`chat-start.ts`)
- [x] Web: per-chat model/effort state in a hook outside `useProjectChatState.ts`, keyed to the
      agent type it was chosen for; reset on new chat / project switch / successful submit
- [x] Web: Model (`ModelSelect`) and Effort (select with "Profile default") in `ComposerOptionsPanel`,
      placeholders show the inherited value; badge counts them
- [x] Web: `buildBaseSubmitRequest` and `startInstantChatSession` send the overrides
- [x] Web: the To control subtitle shows the effective model/effort when overridden
- [x] Tests: API route-level tests for both endpoints (override wins, unset inherits, unsupported
      effort → 400 with nothing written); web behavioral tests (panel → submit payload, agent switch
      drops overrides); submitRequest unit test
- [x] Docs: agents.md + concepts.mdx Chat options description
- [x] Playwright visual audit (mobile 375, desktop 1280)

## Acceptance Criteria

- [x] Choosing a model and/or effort in Chat options starts the chat with those values on both VM and
      Instant runtimes; leaving them blank uses the skill/profile values
- [x] An effort the resolved agent does not support is rejected with 400 before any task is created
- [x] Switching to a profile with a different agent type drops the overrides (no cross-agent leak)
- [x] The options badge counts model/effort overrides
- [x] Overrides reset after a successful send and on New chat
- [ ] Staging: a chat started with an override runs on the chosen model/effort (verified from the
      session's runtime contract / agent session record)

## References

- `.claude/rules/06-technical-patterns.md` (UI-to-backend data path), `61-guards-must-cover-every-runtime.md`,
  `62-tests-must-observe-the-real-trigger.md`, `18-file-size-limits.md`, `24-no-duplicate-ui-controls.md`

## Implementation Notes

- `resolveTaskAgentOverrides` (`apps/api/src/services/agent-profiles.ts`) reuses `validateProfileEffort`.
  Called before any task effect in `submit-task-implementation.ts` (VM, against
  `agentType || DEFAULT_TASK_AGENT_TYPE || 'opencode'`, matching `agent-session-step.ts`),
  `submit-instant-task.ts` and `routes/chat-start.ts`.
- `submit-task-implementation.ts` was 798 lines; context/attachment validation was extracted to
  `submit-task-input-validation.ts` first (separate commit) so the feature did not cross 800.
- `useProjectChatState.ts` (725 → 716 lines): per-chat override state moved into
  `useComposerOverrides.ts`. Still over 500; a full split is out of scope.
- Discrimination checks done: neutering the resolver reddens the API override/reject tests only;
  reverting chat-start wiring reddens its two tests; removing web `agentFields` from each submit
  path, the agent guard, and the New-chat reset each reddened exactly their test.
- Visual audit found the taller panel pushed To/Send off a 375x667 phone (To bottom 708px).
  Fixed with a `max-h-[50dvh]` scrollable panel and one-row Model/Effort; a measured assertion
  was proven red before the fix.
- Four Playwright audit tests fail identically on `main`; filed
  `tasks/backlog/2026-11-07-fix-preexisting-chat-playwright-audit-failures.md`.
