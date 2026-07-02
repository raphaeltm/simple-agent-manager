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

- [x] Move this task file from `tasks/backlog/` to `tasks/active/` in the feature worktree and commit.
- [x] Replace the blanket VM-agent `validateNoComposeVolumes()` publish guard with validation that permits safe named volume mounts and rejects unsafe/unsupported forms.
- [x] Preserve non-retryable, clear publish errors for host bind mounts, Docker socket mounts, `tmpfs`, `volumes_from`, external volumes, custom drivers/options, anonymous volumes, and undeclared volume references.
- [x] Ensure the compose-publish release callback creates provider-backed volume records only after payload/artifact validation succeeds and only for safe declared volumes.
- [x] Rewrite or preserve compose-publish service volume mounts so deployment apply uses SAM provider-backed mount roots, not Docker-managed local volumes.
- [x] Keep signed `volumeMounts`, mount-before-verify, and mount guard behavior intact.
- [x] Update MCP tool definitions and `get_deployment_guide` so agents are guided to safe named volumes and still warned away from unsafe mount types.
- [x] Update public app-deployment docs to describe safe named Compose volumes through `build_and_publish` and the remaining unsupported mount types.
- [x] Add web API client types/functions for list/create/delete deployment volumes.
- [x] Add a Volumes surface to the deployment environment detail UI using existing production page/components, not a prototype route.
- [x] Display volume inventory fields: name, provider volume id, provider, location, size, status, attached server/node, Linux device when available, and created/updated timestamps.
- [x] Add create volume and delete detached volume actions with clear loading/error/destructive states.
- [x] Keep stop/start/delete environment copy consistent with the volume inventory.
- [x] Add or update Go tests for publish validation and `build_and_publish` job behavior with safe and unsafe Compose volumes.
- [x] Add API tests for compose-publish callback volume creation side effects, unsafe rejection, and no side effects on invalid submissions.
- [x] Add compose-publish apply transform tests proving safe named service volumes resolve to SAM mount roots.
- [x] Add web tests for API client behavior and volume UI states/actions.
- [x] Add Playwright visual audit coverage for the deployment volumes UI on mobile and desktop with normal, empty, many, long text, and error scenarios.
- [x] Run local quality gates and focused test suites throughout implementation.
- [x] Run local specialist review: task-completion-validator, go-specialist, cloudflare-specialist, ui-ux-specialist, security-auditor, test-engineer, doc-sync-validator, constitution-validator.
- [ ] Deploy to staging, delete/recreate nodes as required for vm-agent changes, and verify a real `build_and_publish` Compose app with a safe named volume.
- [ ] Leave or clean up staging resources according to current staging-validation policy, reporting exact project/environment/volume/node evidence.
- [ ] Archive the task after task-completion-validator passes.

## Validation Notes

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/compose-publish-apply.test.ts tests/unit/routes/compose-publish-release-callback.test.ts` passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/deployment-volumes.test.ts` passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/compose-publish-apply.test.ts tests/unit/routes/compose-publish-release-callback.test.ts tests/unit/routes/deployment-volumes.test.ts` passed after the review fix (44 tests).
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/deployment-volumes-panel.test.tsx` passed.
- `pnpm --filter @simple-agent-manager/api typecheck` passed.
- `pnpm --filter @simple-agent-manager/web typecheck` passed.
- `pnpm typecheck` passed, and passed again after the review fix.
- `pnpm --filter @simple-agent-manager/api lint` passed with existing warnings.
- `pnpm --filter @simple-agent-manager/web lint` passed with existing warnings after touched-file import sorting fixes.
- `pnpm --filter @simple-agent-manager/web lint` passed again after Playwright audit coverage was added, with existing warnings only.
- `pnpm --filter @simple-agent-manager/web typecheck` passed again after Playwright audit coverage was added.
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/deployment-volumes-panel.test.tsx` passed again after Playwright audit coverage was added.
- `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/deployment-volumes-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)"` passed, covering normal, long/special text, empty, many-row, and error states with no horizontal overflow assertions.
- `pnpm lint` passed, and passed again after the review fix with existing warnings only.
- `git diff --check` passed.
- `go test ./packages/vm-agent/internal/publish` and `gofmt` are blocked in this workspace because `go` and `gofmt` are not installed.

## Local Specialist Review

- task-completion-validator: implementation checklist is covered except staging verification and final archive; acceptance criterion requiring a live MCP `build_and_publish` volume deployment remains pending Phase 6.
- go-specialist: VM-agent validation now permits only declared safe named volumes and keeps unsafe forms non-retryable; Go tests were added, but local execution/formatting is blocked by missing `go`/`gofmt`.
- cloudflare-specialist: provider volume creation side effects were deferred until after callback/artifact validation. Review found one additional manual UI route risk: creating a new volume could use credential-order provider selection instead of the existing environment volume provider. Fixed by binding manual create to existing environment volume provider/location or environment placement metadata, with route tests.
- ui-ux-specialist: real deployment environment page gained a Volumes tab, with mobile/desktop Playwright audits for normal, empty, long/special text, many-row, and error states. No horizontal overflow found.
- security-auditor: unsafe Compose volume forms remain rejected before build/apply, top-level custom/external volume options are blocked, and manual volume creation now avoids mixed provider/location drift.
- test-engineer: focused API route/service, compose-transform, web component, and Playwright coverage exists for the changed behavior; missing local Go execution is documented as an environment blocker.
- doc-sync-validator: MCP tool definitions, deployment guide, and public app-deployment docs now describe safe named Compose volume support and remaining unsupported mount forms.
- constitution-validator: no new hardcoded deployment endpoints/secrets/config values were added; provider validation uses the shared provider guard.

## UI/UX Validation Report

### Variants Considered

1. Table-heavy volume management tab with fixed columns for provider, attachment, device, and timestamps.
2. Compact summary metrics plus row-card inventory with create/actions above the list.
3. Split create/details layout with a side panel for selected volume details.

### Selected Direction

- Choice: Compact summary metrics plus row-card inventory.
- Why: It matches the existing deployment detail surface, keeps mobile single-column behavior straightforward, and avoids horizontal table pressure from provider IDs and device paths.

### Rubric Scores

| Category | Score (1-5) | Notes |
| --- | ---: | --- |
| Visual hierarchy | 4 | Summary metrics, action row, create form, and inventory rows scan in that order. |
| Interaction clarity | 4 | Create/delete/attach/detach/refresh states use existing buttons, disabled states, and error alerts. |
| Mobile usability | 4 | 375px audit and explicit 320px overflow check passed; content stacks without horizontal scroll. |
| Accessibility | 4 | Native inputs/buttons, labels, aria-labels on icon delete buttons, and text status badges. |
| System consistency | 4 | Uses existing deployment tab patterns, shared `Button`/`Alert`/`StatusBadge`, and token classes. |

### Screenshot Evidence

- Mobile normal: `.codex/tmp/playwright-screenshots/deployment-volumes-normal-375x667.png`
- Mobile long/special text: `.codex/tmp/playwright-screenshots/deployment-volumes-long-special-375x667.png`
- Desktop many volumes: `.codex/tmp/playwright-screenshots/deployment-volumes-many-1280x800.png`
- Desktop error state: `.codex/tmp/playwright-screenshots/deployment-volumes-error-1280x800.png`

### Issues Found/Fixes

- Playwright audit harness initially failed because the manually served production bundle was built without `VITE_API_URL`; rebuilt with the same env used by the Playwright config before validating.
- Strict Playwright text locators were tightened where repeated labels appeared in both summary metrics and rows.

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
