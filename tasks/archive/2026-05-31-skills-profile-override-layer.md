# Skills: Profile Override Layer

## Problem

Skills need to become a first-class, project-scoped repeatable-work entity. They mirror agent profiles structurally, but represent what work to do rather than who the agent is. Task resolution should support the override chain Skill -> Profile -> Project -> User -> Platform, with skills defaulting to task mode.

This task must stop at a draft or clearly labeled do-not-merge PR. Do not merge to production without later explicit human authorization.

## Research Findings

- `apps/api/src/db/schema.ts` defines `agent_profiles`, `profile_runtime_env_vars`, and `profile_runtime_files`; migrations live under `apps/api/src/db/migrations/` and must be additive only.
- Profile CRUD is implemented in `apps/api/src/services/agent-profiles.ts` and `apps/api/src/routes/agent-profiles.ts`, with runtime env/file routes in `apps/api/src/routes/profile-runtime.ts` and encryption helpers in `apps/api/src/services/profile-runtime-assets.ts`.
- Task submission resolution is duplicated across `apps/api/src/routes/tasks/submit.ts`, `apps/api/src/services/trigger-submit.ts`, `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts`, and `apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts`.
- Workspace runtime asset injection happens in `apps/api/src/routes/workspaces/_helpers.ts` and currently merges project + profile assets only.
- Triggers store `agent_profile_id` in `apps/api/src/db/schema.ts` and `apps/api/src/routes/triggers/crud.ts`; trigger execution calls `submitTriggeredTask()`.
- Web profile UI patterns live under `apps/web/src/components/agent-profiles/`, with API client functions in `apps/web/src/lib/api/agents.ts`, route registration in `apps/web/src/App.tsx`, and project nav in `apps/web/src/components/NavSidebar.tsx`.
- Chat profile selection is split between `apps/web/src/pages/project-chat/ChatInput.tsx`, `apps/web/src/pages/project-chat/useProjectChatState.ts`, and `apps/web/src/components/project-chat/ProjectChatComposer.tsx`. Task submission profile selection is in `apps/web/src/components/task/TaskSubmitForm.tsx`.
- Relevant postmortems:
  - `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`: never use destructive/table-recreate migrations for additive schema changes.
  - `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`: credential/runtime env behavior needs behavioral tests and safe fallback semantics.
  - `docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md`: avoid Hono wildcard middleware leaks across project subrouters.
  - `docs/notes/2026-03-12-message-misrouting-and-metadata-loss-postmortem.md`: avoid silent metadata loss and source-contract tests.

## Implementation Checklist

- [ ] Add additive D1 migration for `skills`, `skill_runtime_env_vars`, `skill_runtime_files`, `tasks.skill_id`, `tasks.skill_hint`, and `triggers.skill_id`.
- [ ] Add Drizzle schema rows and shared API/types/schemas for skills.
- [ ] Implement skill CRUD service and routes, guarded by `requireOwnedProject`, mirroring profile CRUD.
- [ ] Implement skill runtime env var/file routes and service helpers using the same encryption pattern as profile runtime assets.
- [ ] Create a shared resolver for skill/profile/project/platform config resolution, including profile+skill `systemPromptAppend` concatenation and project/profile/skill runtime asset merge.
- [ ] Update user task submit, trigger submit, SAM session `dispatch_task`, and `retry_subtask` to resolve and persist `skill_id`/`skill_hint` consistently.
- [ ] Add optional `skillId` to MCP/SAM `dispatch_task`.
- [ ] Update trigger create/update/read/run paths to store and pass `skill_id`.
- [ ] Update workspace runtime asset loading to merge project + profile + skill assets with skill winning on collisions.
- [ ] Add Skills project nav, `/projects/:id/skills` route, skill list/form UI with resource requirements, and client API helpers/hooks.
- [ ] Add skill selector to chat composer and task submit form, including description and resolved resource summary when selected.
- [ ] Add API/service tests for skill CRUD, validation, runtime env encryption, resolver precedence, prompt concatenation, env/file merge precedence, and all submit entry points.
- [ ] Add focused UI/unit tests and Playwright visual audit coverage for the new Skills page/selector surfaces.
- [ ] Run quality gates: migration safety, lint, typecheck, tests, build, UI visual audit, specialist reviews, staging verification, and CI.
- [ ] Open a draft/do-not-merge PR and stop without merging.

## Acceptance Criteria

- Skills can be created, listed, read, updated, deleted, and scoped to owned projects only.
- Skill runtime env vars and files behave like profile runtime assets, including encrypted secret storage and masked reads.
- Config resolution applies Skill -> Profile -> Project -> User -> Platform where supported, with prompt append concatenating profile then skill text.
- Runtime env/file assets merge project -> profile -> skill, with later layers winning on key/path collision.
- Every task submit path persists `skill_id` and `skill_hint` and starts the TaskRunner DO with the resolved config.
- MCP `dispatch_task` accepts optional `skillId`.
- Skills are discoverable and selectable in the web app from the project nav, chat composer, and task submit form.
- Tests cover CRUD, validation, resolution precedence, prompt concatenation, env/file precedence, runtime env encryption, and all submit paths.
- Migration contains only `CREATE TABLE`, `CREATE INDEX`, and `ALTER TABLE ADD COLUMN` style changes, with no `DROP TABLE`.
- PR is draft or clearly do-not-merge and is not merged to production.
