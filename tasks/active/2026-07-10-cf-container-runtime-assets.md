# Runtime Assets for Instant cf-container ACP Sessions

## Problem

Instant `cf-container` ACP sessions currently start without project/profile/skill runtime environment variables or runtime files. The existing VM/devcontainer path fetches resolved runtime assets from the Worker callback endpoint during provisioning, but the taskless Instant path has no task row for profile/skill context and the standalone vm-agent path never fetches or applies the assets before starting the ACP process.

This must be fixed without putting user runtime assets or secrets into Cloudflare Container launch environment. The Worker/control plane remains the policy resolver; vm-agent only fetches resolved assets with the workspace-scoped callback token and applies them locally at ACP startup.

## Research Findings

- Idea `01KX4KRS8FNYYJQXWDS0QDM0EF` contains the canonical seven-phase plan, security requirements, test matrix, and staging plan.
- `apps/api/src/routes/workspaces/_helpers.ts` currently owns `getWorkspaceRuntimeAssets()`. It resolves project rows, then calls `getWorkspaceTaskRuntimeIds()` and can only discover profile/skill context through a task row.
- `apps/api/src/routes/workspaces/runtime.ts` exposes `GET /api/workspaces/:id/runtime-assets` and already calls `verifyWorkspaceCallbackAuth()`, which rejects node-scoped tokens.
- `apps/api/src/services/profile-runtime-assets.ts` already implements project < profile < skill merge behavior through `mergeRuntimeAssetRows()`, `getProfileRuntimeAssets()`, and `getSkillRuntimeAssets()`.
- `apps/api/src/services/instant-session.ts` receives `agentProfileId` and `skillId`, writes `workspaces.agentProfileHint`, launches the raw Cloudflare Container with minimal bootstrap config, then calls `startSamAwareAgentSession()`.
- `apps/api/src/services/agent-session-bootstrap.ts` inserts `agent_sessions`, but the schema currently lacks `agent_profile_id` and `skill_id` columns.
- `packages/vm-agent/internal/server/project_runtime_assets.go` decodes `isSecret` from the Worker response but drops it when mapping into `bootstrap.ProjectRuntimeEnvVar` / `ProjectRuntimeFile`.
- `packages/vm-agent/internal/server/agent_ws.go` already has the correct pattern for per-session dynamic data: `GitTokenFetcher` is overridden with a workspace-capturing closure outside broad server defaults.
- `packages/vm-agent/internal/acp/session_host_startup.go` prepares env vars before `startAgentProcess()`. In standalone mode `containerID == ""`, so runtime assets should be fetched/applied here before `LocalLauncher.Start()`.
- `packages/vm-agent/internal/bootstrap/bootstrap.go` has devcontainer-only runtime env/file application. It validates env keys and normalizes file paths, but home-relative paths are passed through to shell commands as literal `~` because they are single-quoted.
- `packages/vm-agent/internal/acp/process.go` splits Docker exec env vars into secret/non-secret using name heuristics only; local process launch passes `EnvVars` via `cmd.Env`.
- Relevant lessons:
  - `tasks/archive/2026-02-23-gh-token-empty-in-workspaces.md`: per-session fetchers must capture the session workspace ID, not rely on node/server config.
  - `tasks/archive/2026-06-25-fix-mcp-override-task-state-idor.md`: add boundary and final-query ownership checks for cross-project/session IDs.
  - `tasks/archive/2026-07-10-cf-container-keepalive-sleeping-state.md`: staging cf-container validation should create a real instant session and clean up temporary profile/node records.
- Required rules read: `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/32-cf-api-debugging.md`, and `.claude/rules/35-vertical-slice-testing.md`.

## Implementation Checklist

- [x] Add `agent_profile_id` and `skill_id` nullable columns to `agent_sessions` with schema/migration updates.
- [x] Extend `startSamAwareAgentSession()` input/insert/update paths to persist optional taskless runtime context, and wire `launchInstantSession()` to pass resolved `agentProfileId` and `skillId`.
- [x] Extract workspace runtime asset resolution into an API service that accepts `{ workspaceId, agentSessionId? }`, preserves project < profile < skill precedence, validates project/user ownership, falls back to task and workspace context, and fails closed on invalid session context.
- [x] Update `GET /api/workspaces/:id/runtime-assets` to use the service and optional `agentSessionId` query while preserving workspace-scoped callback auth and node-token rejection.
- [x] Add/adjust API tests for project-only assets, task profile/skill fallback, taskless agent-session context, invalid session context, secret metadata, node-token rejection, and instant launch not embedding asset values in container config.
- [ ] Preserve `IsSecret` through Go runtime asset structs and bootstrap structs.
- [ ] Add runtime-neutral or shared Go helpers for env key validation and standalone runtime file path normalization/application, including `~/...` behavior, traversal rejection, atomic writes where practical, `0600` for secret files, and safe errors/logs.
- [ ] Add a per-session vm-agent runtime asset provider/fetcher that calls `/runtime-assets?agentSessionId=<sessionID>` with the workspace callback token outside `sessionHostMu`.
- [ ] Apply standalone runtime files and inject runtime env vars into ACP `ProcessConfig` before the local ACP process starts; fail startup visibly on fetch/apply failure while allowing empty asset sets.
- [ ] Update Docker exec env handling to honor explicit secret metadata in addition to existing name heuristics.
- [ ] Preserve existing task-backed VM/devcontainer behavior and add targeted regression coverage.
- [ ] Run focused API and Go tests, then the full required quality suite.
- [ ] Run specialist reviews: task-completion-validator, cloudflare-specialist, go-specialist, security-auditor, constitution-validator, and test-engineer.
- [ ] Coordinate staging deployment, deploy via `deploy-staging.yml`, verify migrations via CF API, create a staging profile/skill with env/file/secret assets, start a real Instant cf-container session, verify asset presence without echoing secret values, confirm no launch-env secret leakage, and clean up.
- [ ] Open PR, wait for CI, merge when green, monitor production deploy, and update idea `01KX4KRS8FNYYJQXWDS0QDM0EF` with PR/merge status.

## Acceptance Criteria

- Instant `cf-container` agents receive configured project/profile/skill runtime env vars at ACP startup.
- Instant `cf-container` workspaces receive configured runtime files before the agent starts acting.
- Runtime assets are not placed into Cloudflare Container launch env.
- Profile/skill runtime assets work for taskless Instant sessions, not only task-backed sessions.
- Task-backed VM/devcontainer runtime asset behavior remains intact.
- `isSecret` survives Worker response, Go structs, process env handling, and file application.
- Secret files are written with owner-only permissions where possible.
- Missing or failing runtime asset fetch/apply fails visibly and does not silently start an underconfigured ACP session.
- Empty runtime asset sets are valid.
- Tests cover task-backed fallback, taskless Instant context, secret metadata, standalone file application, ACP env injection, and callback auth boundaries.

## References

- SAM idea: `01KX4KRS8FNYYJQXWDS0QDM0EF`
- Related merged PRs: #1557 and #1559
- Key API files: `apps/api/src/routes/workspaces/runtime.ts`, `apps/api/src/routes/workspaces/_helpers.ts`, `apps/api/src/services/instant-session.ts`, `apps/api/src/services/agent-session-bootstrap.ts`, `apps/api/src/db/schema.ts`
- Key vm-agent files: `packages/vm-agent/internal/server/project_runtime_assets.go`, `packages/vm-agent/internal/server/agent_ws.go`, `packages/vm-agent/internal/acp/session_host_startup.go`, `packages/vm-agent/internal/acp/process.go`, `packages/vm-agent/internal/bootstrap/bootstrap.go`
