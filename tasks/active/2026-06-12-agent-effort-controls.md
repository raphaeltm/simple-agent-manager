# Agent effort controls for Claude Code and Codex sessions

## Problem

SAM agent profiles can choose an agent type, model, permissions, workspace shape, and related runtime settings, but they cannot choose the reasoning/thinking effort used by Claude Code or Codex. Users need this as a first-class profile and launch setting because lightweight scans, interactive conversations, deep reviews, long autonomous tasks, and recurring triggers should not all run with the same reasoning posture.

Prior research created SAM idea `01KTN2NZN3MXYM6Z6DQZ9RTV6M`, which established a provider-neutral `AgentEffort` product model and provider mappings.

## Research Findings

- Claude Code supports effort through documented launch controls. The best SAM-managed launch mechanism is `CLAUDE_CODE_EFFORT_LEVEL=<level>` because it is per-session and higher precedence than persistent settings.
- Codex supports `model_reasoning_effort` in `config.toml` and config/profile layers. The current Codex manual does not document a stable effort-specific environment variable, so SAM should write this into its managed Codex config rather than inventing an env var.
- Current profile storage is column-based, not JSON-based. Add explicit schema fields rather than burying effort in arbitrary runtime env.
- `apps/api/src/services/profile-fields.ts` centralizes shared fields for agent profiles and skills. Effort must be added there so skills stay in parity with profiles.
- Normal task submit, MCP dispatch, and trigger submit each resolve profile/skill settings and then pass launch overrides through `startTaskRunnerDO`.
- The TaskRunner DO passes model and permission overrides to `startAgentSessionOnNode`; effort should follow that same path.
- The VM agent already stores per-session profile overrides and applies them to fetched user agent settings before launch. This is the correct boundary for provider-specific mapping.
- Direct ACP session creation currently accepts `agentProfileId` in schema but does not resolve it in the route. If it is a supported model-selection surface, it should be made consistent or explicitly left out with a follow-up.
- Migration safety rule applies: this should only add nullable/defaulted columns with `ALTER TABLE ADD COLUMN`, never table recreation.
- UI changes to profile settings require local Playwright visual audit on mobile and desktop.

## Implementation Checklist

- [ ] Add shared effort constants/types and provider capability helpers.
- [ ] Add D1 migration columns for `agent_profiles` and `skills` using safe `ALTER TABLE ADD COLUMN`.
- [ ] Update Drizzle schema and shared profile/skill/request/resolved types.
- [ ] Update Valibot schemas and MCP profile/skill tool definitions/extraction for effort.
- [ ] Update profile and skill service mapping/resolution so effort defaults to `auto` and skill effort can override profile effort.
- [ ] Thread resolved effort through task submit, MCP dispatch, SAM-session dispatch/retry, trigger submit, TaskRunner DO state, and `startAgentSessionOnNode`.
- [ ] Update VM agent start request payload, profile override storage, settings payload, and launch mapping.
- [ ] Map Claude effort to `CLAUDE_CODE_EFFORT_LEVEL`, omitting `auto`.
- [ ] Map Codex effort to `model_reasoning_effort` in the SAM-managed config block, omitting `auto` and rejecting unsupported `max`.
- [ ] Fix or explicitly handle direct ACP session creation with `agentProfileId` so profile model/effort behavior is consistent.
- [ ] Add effort controls to the profile editor UI and profile summaries without adding top-level composer clutter.
- [ ] Add tests across API/profile/skill resolution, task/MCP/trigger launch propagation, VM agent Claude/Codex mapping, and UI behavior.
- [ ] Run mandatory Playwright visual audit for changed profile UI.
- [ ] Run lint, typecheck, tests, build, and migration safety checks.

## Acceptance Criteria

- Users can set effort on agent profiles for Claude Code and Codex.
- Skills can inherit or override profile effort consistently with model and permission mode.
- Unsupported provider/effort combinations are rejected before launch, especially Codex + `max`.
- Claude Code sessions receive the intended effort through documented launch configuration.
- Codex sessions receive the intended effort through `model_reasoning_effort` in managed config.
- `auto` does not force a provider-specific effort unless explicitly documented and chosen by implementation.
- Task submit, MCP dispatch, trigger-created tasks, and relevant direct session creation paths carry profile effort correctly.
- UI stays compact on mobile and profile summaries expose effort clearly.
- Tests prove provider mappings, resolution precedence, and launch payload propagation.

## References

- SAM idea: `01KTN2NZN3MXYM6Z6DQZ9RTV6M`
- Claude Code docs: `https://code.claude.com/docs/en/model-config`
- Codex manual: `https://developers.openai.com/codex/codex-manual.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
