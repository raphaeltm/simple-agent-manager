# Multi-Level Configuration Override System — Phase 1

**Status:** in progress
**Branch:** `sam/multi-level-configuration-override-01kpg9`
**Task ID:** `01KPG90S0T9WHXYE5H2C9H52FD`
**Idea:** `01KNKRCS8DSX8FREC02AJV23QH`

## Scope

Phase 1 of the Multi-Level Configuration Override idea: add per-project agent defaults (model, permissionMode) so users can configure "this project uses opus-4-7 in bypassPermissions mode" without manually selecting an agent profile on every task.

Phases 2-6 (named credentials, user-level infra defaults, profile library, teams, cleanup) are out of scope for this PR.

## Current resolution chain (before)

```
Model/permissionMode: Task → Agent Profile → User agent settings (async callback) → Platform default
                                             ^^^ skips project layer
VM size/provider/location: Task → Profile → Project → Platform default
```

## Target resolution chain (after)

```
Model/permissionMode: Task → Agent Profile → Project agent defaults (NEW) → User agent settings → Platform default
```

## Research findings

1. **Schema** — `apps/api/src/db/schema.ts:230` projects table has `defaultVmSize`, `defaultAgentType`, `defaultProvider`, etc. but no `agentDefaults`.
2. **Shared types** — `packages/shared/src/types/project.ts` has `Project` + `UpdateProjectRequest` with all defaults. `AgentPermissionMode`, `AgentType`, `VALID_PERMISSION_MODES`, `AGENT_CATALOG` all exist.
3. **Task submit** — `apps/api/src/routes/tasks/submit.ts:415-416` resolves model/permissionMode only from profile. No project layer.
4. **MCP dispatch** — `apps/api/src/routes/mcp/dispatch-tool.ts:532-533` same pattern.
5. **Agent settings callback** — `apps/api/src/routes/workspaces/runtime.ts:240-287` returns ONLY user-level settings from `agent_settings` table. Needs to merge project → user.
6. **Project PATCH route** — `apps/api/src/routes/projects/crud.ts:548` validates each field individually. Returns `toProjectResponse()` from `lib/mappers.ts:67`.
7. **Valibot schema** — `apps/api/src/schemas/projects.ts:17` UpdateProjectSchema.
8. **UI** — `apps/web/src/pages/ProjectSettings.tsx` renders sections. `AgentSettingsSection.tsx` shows the pattern for per-agent model + permission mode cards. `ModelSelect.tsx` is the reusable combobox.

## Implementation checklist

### Schema + Types
- [ ] Migration `0042_project_agent_defaults.sql` — add `agent_defaults TEXT` to projects
- [ ] Update `apps/api/src/db/schema.ts` — add `agentDefaults` text column
- [ ] Add `ProjectAgentDefaults` type in `packages/shared/src/types/project.ts`
- [ ] Add `agentDefaults` to `Project` and `UpdateProjectRequest`
- [ ] Update `UpdateProjectSchema` (valibot) — add agentDefaults validation
- [ ] Update `toProjectResponse()` in mappers.ts to parse JSON

### API routes
- [ ] PATCH `/api/projects/:id` — validate agent types + permission modes in agentDefaults JSON, persist
- [ ] POST `/:id/agent-settings` — merge project → user agent settings

### Task submit + MCP dispatch
- [ ] `apps/api/src/routes/tasks/submit.ts` — resolve model/permissionMode from project.agentDefaults
- [ ] `apps/api/src/routes/mcp/dispatch-tool.ts` — same

### UI
- [ ] New `ProjectAgentDefaultsSection` component — per-agent cards with ModelSelect + permission mode selector
- [ ] Wire into `apps/web/src/pages/ProjectSettings.tsx`
- [ ] Add `updateProject` call carrying agentDefaults

### Tests
- [ ] Unit: schema + types contain agentDefaults (structural)
- [ ] Unit: PATCH validation rejects invalid agent types + permission modes
- [ ] Unit: agent-settings callback merges project defaults (unit)
- [ ] Capability: submit route resolves project.agentDefaults correctly (integration-style w/ mocks)

## Acceptance Criteria (Phase 1)

- [ ] Project settings page shows per-agent-type model dropdown and permission mode selector
- [ ] Settings persist via API and survive page reload
- [ ] Task execution uses project agent defaults when no explicit override or agent profile
- [ ] Agent profiles still take precedence over project defaults
- [ ] User-level settings still apply as fallback
- [ ] Clearing a project default falls back to user-level setting
- [ ] Works for all agent types (claude-code, openai-codex, mistral-vibe, google-gemini, opencode)
- [ ] VM agent callback returns merged settings (project → user)

## Design decision: JSON column

Using JSON `Record<AgentType, { model?, permissionMode? }>` per the idea's recommendation — keeps per-type config when switching `defaultAgentType`, matches mental model of user-level settings.
