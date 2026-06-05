# Remove Automatic Default Agent Profiles

## Problem

Fresh projects currently receive four seeded built-in agent profiles (`default`, `planner`, `implementer`, `reviewer`) when profiles are listed. Project chat also silently creates a single-agent default profile on first submit. This clutters the UX and hides the product concept that chats, tasks, and triggers should start from an explicit user-created profile.

Related ready idea: `01KSQE75WVZQM7R3VC6N87HX4Z` (`Profile setup wizard for project chat onboarding`).

## Research Findings

- `apps/api/src/services/agent-profiles.ts` calls `seedBuiltinProfiles()` from `listProfiles()`, so deleting all built-ins can cause them to return.
- `apps/api/tests/unit/services/agent-profiles.test.ts` expects built-ins to seed and includes explicit `seedBuiltinProfiles()` tests.
- `apps/web/src/pages/project-chat/useProjectChatState.ts` has `ensureDefaultProfileForSingleAgent()`, which creates `${agent.name} Default` with conversation/lightweight settings during submit.
- `apps/web/src/pages/project-chat/ChatInput.tsx` renders `DefaultProfileBanner` for one-agent/no-profile projects and only shows `NoProfilesGate` when more than one agent exists.
- The existing inline wizard already supports `skipAgentStep = agents.length === 1`, work type, VM size, profile naming, duplicate-name validation, profile creation, and auto-selection.
- UI validation must follow `.claude/rules/17-ui-visual-testing.md` and `.agents/skills/ui-ux-specialist/SKILL.md`.

## Checklist

- [x] Stop normal backend profile listing from seeding built-in profiles.
- [x] Remove or retire built-in seed helpers that are no longer used.
- [x] Update API unit tests so fresh projects list zero profiles.
- [x] Add API test coverage proving deleting all profiles does not re-create built-ins.
- [x] Remove silent single-agent default profile creation from project chat state.
- [x] Make submit open the profile wizard and return `null` whenever configured agents exist but profiles do not.
- [x] Preserve cloud credential and file-upload validation behavior.
- [x] Ensure wizard-created profiles are added, selected, and usable on later submit.
- [x] Stop rendering `DefaultProfileBanner`.
- [x] Use `NoProfilesGate` for any no-profile project with at least one configured agent.
- [x] Keep one-agent wizard setup short by skipping agent selection.
- [x] Update project chat unit tests for no agents, one agent/no profiles, multiple agents/no profiles, existing profiles, deletion to no profiles, duplicate names, provider catalog fallback, cloud credentials, long names, and active follow-up inputs where relevant.
- [x] Run targeted API and web unit tests.
- [x] Run screenshot-backed Playwright UI audit at 375x667 and 1280x800.
- [x] Run required quality checks.
- [x] Complete specialist review and staging verification before PR merge.

## Acceptance Criteria

- Fresh projects list zero agent profiles until the user creates one.
- Deleting all profiles in a project does not re-seed built-ins.
- Existing seeded profiles in old projects are preserved, editable, and deletable.
- No chat submission silently creates a default profile.
- `agents.length === 0` keeps the Settings > Agents prompt and disabled composer.
- `agentProfiles.length === 0 && agents.length >= 1` shows `Create a profile to start`, disables submit, and opens the inline wizard.
- One-agent wizard skips agent selection but still asks work type, VM size, and profile name.
- Wizard-created profile auto-selects and enables the composer for the next submit.
- Existing profile pill bar and `+ New` behavior are unchanged.
- MCP `dispatch_task` defaults and project-level agent defaults are not changed.
