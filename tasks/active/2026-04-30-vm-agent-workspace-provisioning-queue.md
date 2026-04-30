# VM agent workspace provisioning queue

## Problem

Workspace creation can reach a freshly booted VM after the VM agent HTTP server is reachable but before system provisioning has completed. The agent starts HTTP early for `/health` and boot-log streaming, then runs provisioning steps such as Node.js install, devcontainer CLI install, base image pre-pull, and a final Docker restart.

In debug package `/workspaces/.private/debug-01KQEHX3YKVRNHQ3XZ5YZAXT8C.tar.gz`, workspace `01KQEJ126TC0ZCG3HBBTEEZB6X` was accepted at `2026-04-30T06:43:11Z` while node provisioning was still running. Its devcontainer flow entered `docker buildx build` at `06:43:21Z`; node provisioning restarted Docker at `06:43:23Z`; the build failed at `06:43:24Z` with:

```text
ERROR: failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF
```

The retry workspace succeeded because it started after node provisioning completed. The system needs a VM-agent-side queue/barrier so this race cannot recur even if the control plane dispatches early.

SAM idea: `01KQEMP59T86QN6WHAT05JK4AK`

## Research Findings

- `packages/vm-agent/main.go` starts the HTTP server before `provision.Run()` so `/health` and boot-log streaming are available during provisioning.
- `packages/vm-agent/main.go` calls `srv.SendNodeReady()` after `provision.Run()`, but a workspace request can still arrive before that callback path completes or from another API path.
- `packages/vm-agent/internal/provision/provision.go` runs `image-prepull` in the background, waits for it, then performs `docker-restart`; this restart invalidates active Docker API/build operations.
- `packages/vm-agent/internal/server/workspaces.go` accepts `POST /workspaces`, upserts runtime state, emits `workspace.provisioning`, and immediately calls `startWorkspaceProvision(...)`.
- API callers include:
  - `apps/api/src/routes/node-lifecycle.ts`
  - `apps/api/src/routes/workspaces/_helpers.ts`
  - `apps/api/src/durable-objects/task-runner/workspace-steps.ts`
- Staging rules for `packages/vm-agent/` changes require deleting existing staging nodes before testing so the fresh VM downloads the new binary.
- Relevant post-mortem: `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md` requires real VM provisioning for infrastructure changes; UI/API-only checks are insufficient.

## Implementation Checklist

- [x] Add a VM-agent provisioning readiness gate owned by `server.Server` or a small injected helper.
- [x] Keep early HTTP server startup unchanged for `/health` and boot logs.
- [x] Change `POST /workspaces` so requests received before provisioning completes are persisted as `creating`, emit a clear queue event, and enqueue the existing workspace provision request instead of starting Docker/devcontainer work immediately.
- [x] Drain queued workspace provisions in FIFO order when system provisioning completes.
- [x] If system provisioning fails, fail queued workspace provisions with actionable detail instead of hanging indefinitely.
- [x] Ensure normal post-provisioning `POST /workspaces` behavior still starts immediately.
- [x] Add unit tests proving queued workspace requests do not start devcontainer/container setup before readiness is released.
- [x] Add unit tests proving queued requests drain after readiness and fail on provisioning failure.
- [x] Update docs if any debug/health behavior changes. No docs required: `/health` and boot-log behavior remain unchanged.
- [x] Run local Go tests for VM-agent server/provisioning behavior.
- [x] Run repo quality checks required by `/do`.
- [ ] Deploy to staging, delete existing nodes first, provision a fresh VM, and verify a workspace can be created without racing Docker restart.
- [ ] If staging cannot validate the race/fix with a real VM, pause for human review before PR merge.

## Acceptance Criteria

- A workspace create request received while VM system provisioning is still running cannot start a devcontainer build before `provision.Run()` finishes.
- Queued workspace requests start automatically after successful provisioning.
- Queued workspace requests fail clearly after fatal provisioning failure.
- Existing behavior for already-ready nodes remains unchanged.
- The regression is covered by automated tests.
- Staging verification includes a fresh VM with the new VM agent binary and evidence that the workspace becomes ready only after node provisioning is safe.

## References

- `.codex/prompts/do.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`
