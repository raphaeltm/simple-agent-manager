# Build Publish Provider Volumes and Volume UI

## Problem

SAM has provider-backed deployment volume primitives and runtime mounting, but the product path is incomplete:

1. The agent-facing MCP `build_and_publish` flow still rejects Docker Compose named volumes before build/publish, so agents cannot deploy ordinary stateful Compose apps through the intended publish tool.
2. The web app has no deployment volume inventory or management surface, even though backend volume routes exist and stop/start/delete environment UI already references persistent volumes.

This task implements combined idea `01KWHN2X97VG3DYEVWRPRVZ2K7` and supersedes cancelled UI-only idea `01KWHP5T5VCBJTMKYJBEWCB7V9`.

## Research Findings

- `/do` workflow rules require `.do-state.md`, task-file persistence, a feature worktree, full validation, local specialist review, staging verification, PR, and merge unless blocked.
- Existing backend volume routes are in `apps/api/src/routes/deployment-volumes.ts`:
  - `POST /api/projects/:projectId/environments/:envId/volumes`
  - `GET /api/projects/:projectId/environments/:envId/volumes`
  - `DELETE /api/projects/:projectId/environments/:envId/volumes/:volumeId`
  - `POST /api/projects/:projectId/environments/:envId/volumes/attach`
  - `POST /api/projects/:projectId/environments/:envId/volumes/detach`
- Existing backend volume helpers are in `apps/api/src/services/deployment-volumes.ts`.
  They create provider-backed volume records, build mount descriptors, attach/detach to linked deployment nodes, and delete detached provider volumes.
- PR #1301 added backend volume lifecycle APIs and explicitly documented that it had no UI surfaces yet.
- PR #1435 added exclusive volume nodes, signed `volumeMounts`, vm-agent volume mounting, and stop/start persistence. Its staging proof used direct manifest release submission with a busybox `/data` volume, not MCP `build_and_publish`.
- `packages/vm-agent/internal/publish/build.go` currently calls `validateNoComposeVolumes()` before build and rejects all top-level `volumes:`, service `volumes:`, `volumes_from`, and `tmpfs` with `unsupported_compose_volumes`.
- `apps/api/src/routes/mcp/deployment-guide-tools.ts` and `apps/www/src/content/docs/docs/guides/app-deployments.md` still tell agents/users that `build_and_publish` does not support Compose volumes.
- `apps/api/src/routes/projects/compose-publish-release-callback.ts` already extracts top-level volume declarations with `extractComposePublishVolumeDeclarations()`, creates missing provider volumes, and marks environments as `requiresVolumes`.
- `apps/api/src/services/compose-publish-apply.ts` already has a safer transform path for compose-publish releases, including `validateSafeNamedVolumes()`, but the final apply compose still re-emits Compose named volumes rather than binding them to provider-backed SAM mount roots.
- `apps/api/src/services/compose-renderer.ts` shows the normalized manifest path: service volume mounts render as host bind mounts under `resolveVolumeMountRoot(environmentId)`.
- `packages/vm-agent/internal/deploy/engine.go` mounts signed `volumeMounts` before `verifyVolumeMounts()`, and the mount guard prevents falling through to unmounted empty directories.
- `apps/web/src/pages/ProjectDeploymentEnvironmentDetail.tsx` has tabs for overview, domains, logs, config, policy, and node/metrics. There is no Volumes tab/panel.
- `apps/web/src/lib/api/deployment.ts` has environment lifecycle types and API clients, but no volume response type or volume API client functions.
- UI changes trigger mandatory Playwright visual audit under `.claude/rules/17-ui-visual-testing.md`.
- This task changes `packages/vm-agent/`; staging verification must use fresh nodes per `.claude/rules/27-vm-agent-staging-refresh.md`.
- Callback route/auth mistakes have caused prior deployment incidents. No new VM-agent callback route is currently expected, but route placement must be checked if that changes.
- Cross-boundary testing is mandatory: at minimum this needs Go publish validation tests, API route/service tests, compose apply transform tests, web API/component tests, and one realistic vertical/capability test for the publish-volume path.

## Implementation Checklist

- [ ] Move this task file from `tasks/backlog/` to `tasks/active/` in the feature worktree and commit.
- [ ] Replace the blanket VM-agent `validateNoComposeVolumes()` publish guard with validation that permits safe named volume mounts and rejects unsafe/unsupported forms.
- [ ] Preserve non-retryable, clear publish errors for host bind mounts, Docker socket mounts, `tmpfs`, `volumes_from`, external volumes, custom drivers/options, anonymous volumes, and undeclared volume references.
- [ ] Ensure the compose-publish release callback creates provider-backed volume records only after payload/artifact validation succeeds and only for safe declared volumes.
- [ ] Rewrite or preserve compose-publish service volume mounts so deployment apply uses SAM provider-backed mount roots, not Docker-managed local volumes.
- [ ] Keep signed `volumeMounts`, mount-before-verify, and mount guard behavior intact.
- [ ] Update MCP tool definitions and `get_deployment_guide` so agents are guided to safe named volumes and still warned away from unsafe mount types.
- [ ] Update public app-deployment docs to describe safe named Compose volumes through `build_and_publish` and the remaining unsupported mount types.
- [ ] Add web API client types/functions for list/create/delete deployment volumes.
- [ ] Add a Volumes surface to the deployment environment detail UI using existing production page/components, not a prototype route.
- [ ] Display volume inventory fields: name, provider volume id, provider, location, size, status, attached server/node, Linux device when available, and created/updated timestamps.
- [ ] Add create volume and delete detached volume actions with clear loading/error/destructive states.
- [ ] Keep stop/start/delete environment copy consistent with the volume inventory.
- [ ] Add or update Go tests for publish validation and `build_and_publish` job behavior with safe and unsafe Compose volumes.
- [ ] Add API tests for compose-publish callback volume creation side effects, unsafe rejection, and no side effects on invalid submissions.
- [ ] Add compose-publish apply transform tests proving safe named service volumes resolve to SAM mount roots.
- [ ] Add web tests for API client behavior and volume UI states/actions.
- [ ] Add Playwright visual audit coverage for the deployment volumes UI on mobile and desktop with normal, empty, many, long text, and error scenarios.
- [ ] Run local quality gates and focused test suites throughout implementation.
- [ ] Run local specialist review: task-completion-validator, go-specialist, cloudflare-specialist, ui-ux-specialist, security-auditor, test-engineer, doc-sync-validator, constitution-validator.
- [ ] Deploy to staging, delete/recreate nodes as required for vm-agent changes, and verify a real `build_and_publish` Compose app with a safe named volume.
- [ ] Leave or clean up staging resources according to current staging-validation policy, reporting exact project/environment/volume/node evidence.
- [ ] Archive the task after task-completion-validator passes.

## Acceptance Criteria

- `build_and_publish` accepts a Compose file with `services.web.volumes: [data:/data]` and top-level `volumes.data`, then publishes a release that creates and uses a SAM provider-backed volume.
- Unsafe mount forms still fail before build/apply with a specific error code/message and without provider side effects.
- Deployment apply payloads continue to include signed `volumeMounts`, and vm-agent mount guard still blocks unmounted volume fall-through.
- The deployment guide and public docs no longer claim safe named Compose volumes are unsupported by `build_and_publish`.
- The environment detail UI shows deployment volumes and lets users create and delete detached volumes with clear feedback.
- UI tests prove volume data flows from API responses into the rendered UI and user actions reach the correct API endpoints.
- Local Playwright screenshots/audits show no mobile or desktop overflow for the changed volume UI.
- Staging verification exercises the actual MCP `build_and_publish` flow with a Compose named volume and verifies data persistence behavior end-to-end.

## References

- Combined idea: `01KWHN2X97VG3DYEVWRPRVZ2K7`
- Cancelled duplicate idea: `01KWHP5T5VCBJTMKYJBEWCB7V9`
- PR #1301: Environment volume lifecycle + compose renderer mounts
- PR #1435: Deployment volume mounts with exclusive nodes
- `packages/vm-agent/internal/publish/build.go`
- `packages/vm-agent/internal/server/mcp_build.go`
- `apps/api/src/routes/mcp/compose-publish-tools.ts`
- `apps/api/src/routes/mcp/deployment-guide-tools.ts`
- `apps/api/src/routes/projects/compose-publish-release-callback.ts`
- `apps/api/src/services/compose-publish-apply.ts`
- `apps/api/src/services/deployment-volumes.ts`
- `apps/api/src/routes/deployment-volumes.ts`
- `apps/api/src/services/compose-renderer.ts`
- `packages/vm-agent/internal/deploy/engine.go`
- `packages/vm-agent/internal/deploy/mount_guard.go`
- `apps/web/src/pages/ProjectDeploymentEnvironmentDetail.tsx`
- `apps/web/src/lib/api/deployment.ts`
- `apps/www/src/content/docs/docs/guides/app-deployments.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/30-never-ship-broken-features.md`
- `.claude/rules/35-vertical-slice-testing.md`
