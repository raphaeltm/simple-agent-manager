# Adopt Valibot for API Route Input Validation

## Problem

All API routes use `c.req.json<Type>()` which provides zero runtime validation — the type parameter is compile-time only. Malformed requests can cause unexpected 500 errors instead of descriptive 400 responses. We need to adopt Valibot with `@hono/valibot-validator` middleware for runtime request body validation.

## Research Findings

### Current State
- **59 `c.req.json` calls** across 22+ route files
- One existing hand-rolled validation file: `routes/ui-governance.schemas.ts` (uses manual `ensureRecord`/`ensureString` helpers)
- All request types are defined in `packages/shared/src/types.ts` and `packages/shared/src/agents.ts`
- Key enums: `VMSize`, `WorkspaceProfile`, `CredentialProvider`, `TaskStatus`, `TaskMode`, `AgentPermissionMode`, `CredentialKind`, `AgentType`, `NotificationType`, `NotificationChannel`, `NotificationUrgency`
- The `CreateCredentialRequest` type is a discriminated union by `provider` field

### Route Files to Migrate
1. `routes/tasks/submit.ts` — SubmitTaskRequest
2. `routes/tasks/crud.ts` — CreateTaskRequest, UpdateTaskRequest, UpdateTaskStatusRequest, CreateTaskDependencyRequest, DelegateTaskRequest
3. `routes/tasks/run.ts` — RunTaskRequest
4. `routes/tasks/upload.ts` — RequestAttachmentUploadRequest
5. `routes/projects/crud.ts` — CreateProjectRequest, UpdateProjectRequest, UpsertProjectRuntimeEnvVarRequest, UpsertProjectRuntimeFileRequest
6. `routes/projects/acp-sessions.ts` — AcpSession* requests
7. `routes/credentials.ts` — CreateCredentialRequest, SaveAgentCredentialRequest, { credentialKind }
8. `routes/nodes.ts` — CreateNodeRequest, inline types
9. `routes/workspaces/crud.ts` — CreateWorkspaceRequest, UpdateWorkspaceRequest
10. `routes/workspaces/agent-sessions.ts` — CreateAgentSessionRequest, { label }
11. `routes/workspaces/runtime.ts` — Various inline types (agentType, credential injection, boot logs)
12. `routes/workspaces/lifecycle.ts` — { status }, { errorMessage }
13. `routes/notifications.ts` — UpdateNotificationPreferenceRequest
14. `routes/agent-profiles.ts` — CreateAgentProfileRequest, UpdateAgentProfileRequest, { profileNameOrId }
15. `routes/agent-settings.ts` — SaveAgentSettingsRequest
16. `routes/smoke-test-tokens.ts` — { name }, { token }
17. `routes/cached-commands.ts` — inline cache command
18. `routes/tts.ts` — { text, storageId, mode }
19. `routes/chat.ts` — various inline types
20. `routes/terminal.ts` — { workspaceId }
21. `routes/admin.ts` — { action }, { role }, generic json
22. `routes/gcp.ts` — { oauthHandle }, connection config
23. `routes/project-deployment.ts` — { oauthHandle }, deployment config
24. `routes/ui-governance.ts` — already has manual validation, migrate to Valibot
25. `routes/client-errors.ts` — error report body
26. `routes/mcp/index.ts` — JsonRpcRequest (special case - may keep as-is)

### Approach
- Use `@hono/valibot-validator` (`vValidator('json', schema)`) as route middleware
- Define schemas in `apps/api/src/schemas/` directory, one file per domain
- Schemas match existing TypeScript types in `packages/shared`
- Replace `c.req.json<T>()` with `c.req.valid('json')` in handlers
- Remove redundant manual validation checks that schemas now cover
- Keep business-logic validation (DB lookups, auth checks) in handlers
- MCP route (`routes/mcp/index.ts`) is JSON-RPC and may keep its own parsing

## Implementation Checklist

### Phase 1: Setup
- [ ] Install `valibot` and `@hono/valibot-validator` in `apps/api`
- [ ] Create `apps/api/src/schemas/` directory with barrel `index.ts`

### Phase 2: Define Schemas (one file per route domain)
- [ ] `schemas/tasks.ts` — SubmitTaskSchema, CreateTaskSchema, UpdateTaskSchema, UpdateTaskStatusSchema, CreateTaskDependencySchema, DelegateTaskSchema, RunTaskSchema, RequestAttachmentUploadSchema
- [ ] `schemas/projects.ts` — CreateProjectSchema, UpdateProjectSchema, UpsertProjectRuntimeEnvVarSchema, UpsertProjectRuntimeFileSchema
- [ ] `schemas/credentials.ts` — CreateCredentialSchema (discriminated union), SaveAgentCredentialSchema, CredentialKindSchema
- [ ] `schemas/nodes.ts` — CreateNodeSchema, UpdateNodeLabelSchema, PatchNodeSchema
- [ ] `schemas/workspaces.ts` — CreateWorkspaceSchema, UpdateWorkspaceSchema, CreateAgentSessionSchema, UpdateAgentSessionSchema
- [ ] `schemas/notifications.ts` — UpdateNotificationPreferenceSchema
- [ ] `schemas/agent-profiles.ts` — CreateAgentProfileSchema, UpdateAgentProfileSchema, SetProjectDefaultProfileSchema
- [ ] `schemas/agent-settings.ts` — SaveAgentSettingsSchema
- [ ] `schemas/acp-sessions.ts` — AcpSession* schemas
- [ ] `schemas/admin.ts` — AdminActionSchema, AdminRoleSchema, AnalyticsForwardSchema
- [ ] `schemas/misc.ts` — terminal, smoke-test, cached-commands, tts, chat, gcp, project-deployment, client-errors, workspace runtime, lifecycle schemas

### Phase 3: Migrate Routes (one file at a time)
- [ ] Migrate `routes/tasks/submit.ts`
- [ ] Migrate `routes/tasks/crud.ts`
- [ ] Migrate `routes/tasks/run.ts`
- [ ] Migrate `routes/tasks/upload.ts`
- [ ] Migrate `routes/projects/crud.ts`
- [ ] Migrate `routes/projects/acp-sessions.ts`
- [ ] Migrate `routes/credentials.ts`
- [ ] Migrate `routes/nodes.ts`
- [ ] Migrate `routes/workspaces/crud.ts`
- [ ] Migrate `routes/workspaces/agent-sessions.ts`
- [ ] Migrate `routes/workspaces/runtime.ts`
- [ ] Migrate `routes/workspaces/lifecycle.ts`
- [ ] Migrate `routes/notifications.ts`
- [ ] Migrate `routes/agent-profiles.ts`
- [ ] Migrate `routes/agent-settings.ts`
- [ ] Migrate `routes/smoke-test-tokens.ts`
- [ ] Migrate `routes/cached-commands.ts`
- [ ] Migrate `routes/tts.ts`
- [ ] Migrate `routes/chat.ts`
- [ ] Migrate `routes/terminal.ts`
- [ ] Migrate `routes/admin.ts`
- [ ] Migrate `routes/gcp.ts`
- [ ] Migrate `routes/project-deployment.ts`
- [ ] Migrate `routes/ui-governance.ts` (replace manual validators with Valibot)
- [ ] Migrate `routes/client-errors.ts`

### Phase 4: Cleanup & Verification
- [ ] Grep for remaining `c.req.json<` calls — should be zero (except MCP JSON-RPC if kept)
- [ ] Remove `routes/ui-governance.schemas.ts` manual validators
- [ ] Run `pnpm typecheck && pnpm lint`
- [ ] Run `pnpm test`

### Phase 5: Testing
- [ ] Add validation tests for schema correctness (valid/invalid input)
- [ ] Add integration tests: malformed JSON → 400 (not 500)
- [ ] Verify error response format matches existing `{ error, message }` pattern

## Acceptance Criteria
- [ ] Every API route that accepts a request body uses Valibot schema validation
- [ ] Zero `c.req.json<Type>()` calls with compile-time-only type annotations (except MCP JSON-RPC)
- [ ] Malformed requests return 400 with descriptive error messages (not 500)
- [ ] Schema types match shared TypeScript types
- [ ] All existing tests pass
- [ ] New validation-specific tests added

## References
- `apps/api/src/routes/` — all route files
- `packages/shared/src/types.ts` — request type definitions
- `packages/shared/src/agents.ts` — agent-related types (AgentType, CredentialKind, SaveAgentCredentialRequest)
- `apps/api/src/routes/ui-governance.schemas.ts` — existing manual validation (to be replaced)
- Valibot docs: https://valibot.dev/
- `@hono/valibot-validator` — Hono middleware for Valibot
