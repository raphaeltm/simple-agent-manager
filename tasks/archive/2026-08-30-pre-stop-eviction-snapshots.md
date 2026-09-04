# Pre-stop eviction snapshots for VM agent

## Summary

Implement VM-agent eviction handling for ResourceGuard pressure events. Critical pressure and container OOM events must capture an existing session snapshot while the container is still running, then stop the container with `docker stop`, mark the workspace evicted locally, and notify the control plane. Warning pressure is informational only.

## Branching

- Working branch: `sam/implement-pre-stop-snapshot-bs3vz9`
- Base/PR target: `sam/layered-resource-management`
- SAM task: `01M19FTM2MT79QA3FVHYBS3VZ9`

## Acceptance criteria

- [x] Add `packages/vm-agent/internal/resourcemon/eviction.go` eviction controller.
- [x] Subscribe to `ResourceGuard.PressureEvents()` and handle warning/critical events.
- [x] On critical pressure or container OOM, capture a synchronous snapshot before container stop.
- [x] Proceed with `docker stop` even when snapshot capture fails or times out.
- [x] Preserve overlay filesystem by never using `docker rm -f` in the eviction path.
- [x] Mark local VM-agent workspace status as `evicted`.
- [x] Notify the control plane with workspace ID, reason, snapshot success, and stop success.
- [x] Debounce duplicate evictions for the same container using configurable `DEFAULT_EVICTION_DEBOUNCE_SECONDS`.
- [x] Bound eviction snapshot capture with configurable `DEFAULT_EVICTION_SNAPSHOT_TIMEOUT_SECONDS`.
- [x] Bound pressure target workspace/container resolution with configurable `DEFAULT_EVICTION_RESOLVE_TIMEOUT_SECONDS`.
- [x] Serialize evictions so only one runs at a time.
- [x] Select the largest memory consumer from ResourceGuard container stats when a system critical event has no specific container.
- [x] Add control-plane callback route `POST /api/projects/:id/workspaces/:workspaceId/eviction`.
- [x] Authenticate callback route with callback JWT only, mounted before `projectsRoutes`.
- [x] Callback route updates D1 workspace status to `evicted`, records an event, and broadcasts via ProjectData activity.
- [x] Tests cover ordering, debounce, serialization, timeout/failure fallback, largest consumer selection, callback auth, status update, and terminal classifications.

## Research notes

- `ResourceGuard` emits `PressureEvent` values through `PressureEvents()` and exposes cloned latest pressure via `CurrentPressure()`.
- `PressureEventContainerOOM` includes `WorkspaceID`, `ContainerID`, and `ContainerName`; system PSI critical events may not.
- Existing snapshot capture (`hibernateSessionSnapshot`) uses `docker exec` through `createContainerHomeTar`, `containerGit`, and related helpers, so it must run before the eviction stop.
- Synchronous hibernate behavior already exists through `captureSessionSnapshot` / `handleHibernateAgentSession` when `background=false`.
- VM-agent runtime state needs a chat-session ID captured for eviction because snapshot preparation requires `chatSessionId`.
- Existing callback routes use `extractBearerToken()` + `verifyCallbackToken()` and must be mounted before `projectsRoutes` to avoid browser session auth.

## Implementation checklist

- [x] Add VM-agent config defaults/env loading/validation for eviction debounce, snapshot timeout, Docker stop timeout, and target resolve timeout.
- [x] Add `ChatSessionID` to `WorkspaceRuntime` and persist/update it where runtime session context is learned.
- [x] Add server adapter methods for eviction snapshot capture, container resolution, docker stop, local status update, and control-plane notification.
- [x] Instantiate/start/stop eviction controller with ResourceGuard lifecycle.
- [x] Add resourcemon unit tests for controller behavior.
- [x] Add server tests for synchronous snapshot input capture and local status handling.
- [x] Add API route and worker integration tests.
- [x] Run Go and API tests plus targeted validation.

## Validation

- `PATH=/usr/local/go/bin:$PATH go test ./...` from `packages/vm-agent` — pass
- `PATH=/usr/local/go/bin:$PATH go vet ./...` from `packages/vm-agent` — pass
- `PATH=/usr/local/go/bin:$PATH go test -race ./internal/resourcemon ./internal/server` from `packages/vm-agent` — pass
- `pnpm --filter @simple-agent-manager/api typecheck` — pass
- `pnpm --filter @simple-agent-manager/api lint` — pass
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/route-auth-validation.test.ts` — pass
- `pnpm --filter @simple-agent-manager/shared build` — pass
- `pnpm --filter @simple-agent-manager/shared test` — pass
- `pnpm --filter @simple-agent-manager/web typecheck` — pass
- `pnpm --filter @simple-agent-manager/web lint` — pass with three pre-existing warnings unrelated to this change
- `pnpm --filter @simple-agent-manager/web exec vitest run tests/unit/hooks/workspace-running-status.test.ts` — pass
- `pnpm lint:oxlint` — pass with existing advisory diagnostics only
- `pnpm format:check` — pass
- `git diff --check` — pass

## Specialist review evidence

- Go specialist: addressed — snapshot lock acquisition is context-bounded, ACP session ID is captured before eviction snapshot and used as manifest fallback, pressure target resolution has a configurable timeout, and snapshot container resolution now passes context through Docker discovery. Final follow-up passed.
- Cloudflare specialist: addressed — callback D1 update is guarded on workspace/project/node/active status, zero-change races reload latest state before returning terminal status, and ProjectData activity recording is best-effort via `executionCtx.waitUntil`. Follow-up passed.
- Security auditor: addressed — replayed eviction callbacks for an already-evicted workspace now return terminal 410 before another activity write; Worker callback tests cover the replay case.
- Env validator: pass — new eviction knobs use `DEFAULT_*` constants, env loading, validation, `.env.example`, and env reference docs, including `DEFAULT_EVICTION_RESOLVE_TIMEOUT_SECONDS`.
- Constitution validator: pass — eviction debounce, snapshot timeout, Docker stop timeout, and target resolve timeout are configurable; no new hardcoded operational threshold governs business behavior.
- Test engineer: pass — tests cover snapshot-before-stop ordering, debounce, serialization, timeout/failure stop fallback, largest-consumer selection, bounded resolver/lock paths, outbound callback body/auth, callback auth, D1 update, ProjectData activity, replay, and terminal classifications.
- Doc sync validator: addressed — API and VM-agent env references include the new route/settings, shared status contracts include `evicted`, and the task file now includes the resolve timeout env var.
- Task completion validator: addressed — outbound VM-agent callback and ProjectData activity/replay assertions were added; follow-up passed.

## Out of scope

- Rescheduling evicted workspaces is Step 4 and is not implemented here.
