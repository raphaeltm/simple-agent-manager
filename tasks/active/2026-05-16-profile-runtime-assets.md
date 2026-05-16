# Profile Runtime Assets

## Problem

Project-level runtime environment variables and runtime files already flow from D1 through the API callback into the VM agent. Agent profiles need their own runtime env vars and files that merge with project-level assets at dispatch/runtime callback time, with profile values overriding project values on key/path collisions. This must not require VM agent changes.

The referenced design note `docs/notes/2026-05-16-layered-env-secrets-data-flow.md` is not present in this checkout, so implementation is based on the existing project-runtime code paths and the task description.

## Research Findings

- Project runtime storage lives in `apps/api/src/db/schema.ts` and migration `apps/api/src/db/migrations/0012_project_runtime_config.sql`.
- Project runtime API routes live in `apps/api/src/routes/projects/crud.ts`, with masking for secrets via `buildProjectRuntimeConfigResponse()` in `apps/api/src/routes/projects/_helpers.ts`.
- Workspace runtime assets are fetched by VM callback through `GET /api/workspaces/:id/runtime-assets`, implemented by `getWorkspaceRuntimeAssets()` in `apps/api/src/routes/workspaces/_helpers.ts`.
- Task dispatch persists resolved profile IDs into `tasks.agent_profile_hint` for MCP dispatch, but direct task submission needs the same value persisted so runtime asset lookup can resolve the profile from `workspace_id -> tasks`.
- Agent profile routes use `requireOwnedProject()` and service-layer profile lookup. Runtime asset routes should require project ownership and a project-scoped profile for the requested project.
- MCP profile tools are centralized in `apps/api/src/routes/mcp/profile-tools.ts` with definitions in `tool-definitions-profile-tools.ts`.
- Relevant postmortems:
  - `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`: secret/credential paths need behavioral tests and default-reject ownership checks.
  - `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`: migrations must be additive and avoid destructive table recreation.

## Checklist

- [x] Add additive D1 migration for `profile_runtime_env_vars` and `profile_runtime_files`.
- [x] Add Drizzle schema tables and inferred types.
- [x] Add shared profile runtime service/helper functions for profile ownership validation, CRUD response masking, decryption, and project/profile merge.
- [x] Add HTTP routes for profile runtime env var and file CRUD.
- [x] Mount the new routes under `/api/projects/:projectId/agent-profiles/:profileId/runtime/...`.
- [x] Persist resolved profile ID on direct task submission.
- [x] Merge project + profile runtime assets in the workspace runtime callback, with profile overrides.
- [x] Add MCP tools to add, remove, and list profile env vars.
- [x] Add unit/integration tests for merge behavior, CRUD validation, secret encryption, and dispatch/runtime asset propagation.
- [x] Run quality checks and migration safety checks.

## Acceptance Criteria

- Profile runtime env vars and files are stored in D1 with the same encryption semantics as project runtime assets.
- Profile runtime API access is limited to users who own the project and to profiles scoped to that project.
- Secret profile values are masked in list responses and encrypted at rest.
- Workspace runtime assets include project-level assets plus profile-level assets for the task profile, with profile values winning on collisions.
- Existing VM agent payload/contract remains unchanged.
- MCP agents can add, remove, and list profile env vars.
- Tests prove merge behavior, API CRUD, secret encryption, and runtime callback propagation.
