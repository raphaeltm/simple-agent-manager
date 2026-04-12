# Multiple Devcontainer Configuration Support

## Problem Statement

SAM currently hardcodes devcontainer discovery to `.devcontainer/devcontainer.json` and `.devcontainer.json`. The devcontainer spec supports multiple named configurations via subdirectories under `.devcontainer/` (e.g., `.devcontainer/data-science/devcontainer.json`). Users with repos containing multiple configs cannot select which one to use — SAM always auto-discovers the default.

This feature adds a `devcontainerConfigName` field throughout the stack (shared types → DB → API → VM agent → UI) following the existing `workspaceProfile` pattern.

## Research Findings

### Key Files and Patterns

| Component | File | Key Lines | Pattern |
|-----------|------|-----------|---------|
| Shared types | `packages/shared/src/types/workspace.ts` | 191-201 | `CreateWorkspaceRequest` interface |
| Shared types | `packages/shared/src/types/agent-settings.ts` | 52-89 | `AgentProfile`, `CreateAgentProfileRequest` |
| Shared types | `packages/shared/src/types/task.ts` | 227-252 | `SubmitTaskRequest` |
| Constants | `packages/shared/src/constants/defaults.ts` | 10-11 | `DEFAULT_WORKSPACE_PROFILE`, `VALID_WORKSPACE_PROFILES` |
| DB schema | `apps/api/src/db/schema.ts` | 249 (projects), 575 (workspaces), 713 (agent_profiles) | nullable text columns |
| Task submit | `apps/api/src/routes/tasks/submit.ts` | 244-247 | 4-tier resolution: explicit → profile → project → default |
| Task schema | `apps/api/src/schemas/tasks.ts` | 33-46 | Valibot schema validation |
| Workspace steps | `apps/api/src/durable-objects/task-runner/workspace-steps.ts` | 140-149 | Derives `lightweight` boolean, calls `createWorkspaceOnNode` |
| Node agent | `apps/api/src/services/node-agent.ts` | 182-203 | `createWorkspaceOnNode()` sends JSON to VM agent |
| TaskRunner types | `apps/api/src/durable-objects/task-runner/types.ts` | 33-73 | `TaskRunConfig` interface |
| TaskRunner DO start | `apps/api/src/services/task-runner-do.ts` | 27-113 | `startTaskRunnerDO()` |
| Agent profiles | `apps/api/src/services/agent-profiles.ts` | 358-481 | `resolveAgentProfile()` resolution chain |
| MCP dispatch | `apps/api/src/routes/mcp/dispatch-tool.ts` | 331-334 | Same 4-tier resolution |
| VM bootstrap | `packages/vm-agent/internal/bootstrap/bootstrap.go` | 94-102 (ProvisionState), 910-918 (devcontainerUpArgs), 1066-1087 (runReadConfiguration), 1518-1530 (hasDevcontainerConfig) |
| VM workspace handler | `packages/vm-agent/internal/server/workspaces.go` | 278-346 | HTTP handler reads JSON body |
| TaskSubmitForm | `apps/web/src/components/task/TaskSubmitForm.tsx` | 425-459 | Dropdown conditional on `!hasProfile` |
| ChatInput | `apps/web/src/pages/project-chat/ChatInput.tsx` | 193-280 | Mobile + desktop dropdowns |
| ProfileFormDialog | `apps/web/src/components/agent-profiles/ProfileFormDialog.tsx` | 280-295 | Infrastructure section |
| ProjectSettings | `apps/web/src/pages/ProjectSettings.tsx` | No devcontainer config yet |
| useProjectChatState | `apps/web/src/pages/project-chat/useProjectChatState.ts` | 86-96 | State + auto-adjust pattern |

### Migration Pattern
Latest migration: `0039_compute_quotas.sql`. Next: `0040`.
Pattern for adding nullable columns: `ALTER TABLE <table> ADD COLUMN <name> TEXT;`

### Resolution Chain (Existing Pattern for workspaceProfile)
1. Explicit field in request body
2. Agent profile override
3. Project default
4. Platform default (null = auto-discover)

### VM Agent Pattern
- `devcontainerUpArgs()` already supports `--override-config` flag
- Need to add `--config` flag (different from `--override-config`) for selecting named configs
- `hasDevcontainerConfig()` only checks 2 paths — needs to also scan subdirectories
- `ProvisionState` has `Lightweight bool` — needs `DevcontainerConfigName string`

## Implementation Checklist

### Phase 1: Shared Types & Constants
- [ ] Add `DEVCONTAINER_CONFIG_NAME_REGEX` validation constant to `packages/shared/src/constants/defaults.ts`
- [ ] Add `devcontainerConfigName?: string | null` to `CreateWorkspaceRequest` in `packages/shared/src/types/workspace.ts`
- [ ] Add `devcontainerConfigName?: string | null` to `WorkspaceResponse` in `packages/shared/src/types/workspace.ts`
- [ ] Add `devcontainerConfigName?: string | null` to `SubmitTaskRequest` in `packages/shared/src/types/task.ts`
- [ ] Add `devcontainerConfigName: string | null` to `AgentProfile` in `packages/shared/src/types/agent-settings.ts`
- [ ] Add `devcontainerConfigName?: string | null` to `CreateAgentProfileRequest` in `packages/shared/src/types/agent-settings.ts`
- [ ] Add `devcontainerConfigName: string | null` to `ResolvedAgentProfile` type
- [ ] Export new types/constants from barrel files
- [ ] Build shared package

### Phase 2: Database Migration
- [ ] Create `0040_devcontainer_config_name.sql` adding nullable `devcontainer_config_name` column to `workspaces`, `agent_profiles`, and `projects` tables
- [ ] Add `devcontainerConfigName` column to `workspaces` table in schema.ts
- [ ] Add `devcontainerConfigName` column to `agent_profiles` table in schema.ts
- [ ] Add `defaultDevcontainerConfigName` column to `projects` table in schema.ts

### Phase 3: API Layer
- [ ] Add `DevcontainerConfigNameSchema` to `apps/api/src/schemas/tasks.ts` (valibot string validation with regex)
- [ ] Add `devcontainerConfigName` to `SubmitTaskSchema`
- [ ] Add `devcontainerConfigName` resolution to `routes/tasks/submit.ts` (explicit → profile → project → null)
- [ ] Add `devcontainerConfigName` to `TaskRunConfig` in `durable-objects/task-runner/types.ts`
- [ ] Pass `devcontainerConfigName` through `startTaskRunnerDO()` in `services/task-runner-do.ts`
- [ ] Pass `devcontainerConfigName` to workspace record and `createWorkspaceOnNode()` in `workspace-steps.ts`
- [ ] Add `devcontainerConfigName` field to `createWorkspaceOnNode()` in `services/node-agent.ts`
- [ ] Add `devcontainerConfigName` to MCP dispatch tool resolution in `routes/mcp/dispatch-tool.ts`
- [ ] Add `devcontainerConfigName` to agent profile CRUD (service + routes)
- [ ] Add `devcontainerConfigName` to project PATCH endpoint
- [ ] Add devcontainer config discovery endpoint: `GET /api/projects/:id/devcontainer-configs`

### Phase 4: VM Agent
- [ ] Add `DevcontainerConfigName string` field to `ProvisionState` struct in `bootstrap.go`
- [ ] Update `hasDevcontainerConfig()` to scan `.devcontainer/*/devcontainer.json` subdirectories
- [ ] Update `devcontainerUpArgs()` to pass `--config .devcontainer/<name>/devcontainer.json` when config name is set
- [ ] Update `runReadConfiguration()` to pass `--config` when config name is set
- [ ] Add `devcontainerConfigName` to workspace creation request body struct in `workspaces.go`
- [ ] Pass config name through workspace runtime to bootstrap

### Phase 5: Web UI
- [ ] Add devcontainer config name dropdown to `TaskSubmitForm.tsx` (visible when profile is "Full" and `!hasProfile`)
- [ ] Add devcontainer config name dropdown to `ChatInput.tsx` (mobile + desktop, visible when profile is "Full")
- [ ] Add devcontainer config name field to `ProfileFormDialog.tsx` Infrastructure section
- [ ] Add default devcontainer config setting to `ProjectSettings.tsx`
- [ ] Add state management in `useProjectChatState.ts`
- [ ] Wire config discovery API call for populating dropdown options
- [ ] Display config name in session/workspace details where relevant

### Phase 6: Tests
- [ ] Unit tests for config name validation (shared package)
- [ ] Unit tests for resolution chain (API layer)
- [ ] Unit tests for `hasDevcontainerConfig()` scanning subdirectories (VM agent)
- [ ] Unit tests for `devcontainerUpArgs()` with `--config` flag (VM agent)
- [ ] Integration test for task submission with config name
- [ ] Contract test for API → VM agent config name passthrough

## Acceptance Criteria

- [ ] Users can specify a devcontainer config name when submitting tasks (via form or MCP)
- [ ] Agent profiles can pin a devcontainer config name
- [ ] Projects can set a default devcontainer config name
- [ ] Resolution chain follows: explicit → agent profile → project default → null (auto-discover)
- [ ] VM agent uses `--config` flag when config name is specified
- [ ] VM agent scans subdirectories when checking for devcontainer configs
- [ ] Config name is validated (alphanumeric, hyphens, underscores only)
- [ ] Lightweight profile ignores config name (devcontainer build skipped entirely)
- [ ] Config discovery endpoint returns available configs from linked GitHub repo
- [ ] UI shows config dropdown only when workspace profile is "Full"
- [ ] All changes have test coverage

## References

- Devcontainer spec: https://containers.dev/implementors/spec/#devcontainerjson
- Idea: 01KP0H833AN5PZ1M6D6CQ4WNWP
- Existing pattern: `workspaceProfile` resolution chain in `routes/tasks/submit.ts:244-247`
