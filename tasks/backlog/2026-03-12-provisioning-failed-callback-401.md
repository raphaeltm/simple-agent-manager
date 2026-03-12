# Workspace Provisioning-Failed Callback Returns 401

**Date**: 2026-03-12
**Discovered during**: Same-zone routing fix verification (production task submission)
**Severity**: High — task runner gets stuck indefinitely when provisioning fails

## Problem

When workspace provisioning fails on a VM, the VM agent calls `POST /api/workspaces/:id/provisioning-failed` to report the failure. This callback returns 401 "Authentication required", so the task runner never learns about the failure and remains stuck indefinitely in the `workspace_ready` polling state.

**Evidence**: Cloudflare Workers observability logs show:
- `POST /api/workspaces/01KKHG4WPE56KAJHS565X0FWFR/provisioning-failed` → 401, 0ms wallTime
- Error: "Authentication required"
- Task runner alarm stopped firing after this — stuck waiting forever

## Context

Observed during production verification of the same-zone routing fix. The route exclusion fix works correctly (workspace creation reaches the VM), but the workspace provisioning itself fails within ~10 seconds. The failure callback gets 401, so the task runner is stuck.

## Root Cause Investigation Needed

1. **Why does provisioning fail?** The failure happens within 10 seconds of workspace creation — likely an early failure (git clone auth, Docker issue, or config problem), not a devcontainer build timeout.

2. **Why does the callback get 401?** The `provisioning-failed` endpoint requires authentication. Need to determine: does it use a node JWT, workspace JWT, or bootstrap token? If the bootstrap token was already consumed during workspace creation, the VM agent may not have valid credentials for subsequent callbacks.

3. **Why is there no timeout?** The task runner should have a maximum wait time for workspace readiness. If no ready/failed callback arrives within N minutes, the task should fail with a timeout error.

## Acceptance Criteria

- [ ] Identify why provisioning fails on new VMs (check VM agent logs if possible)
- [ ] Fix the 401 on provisioning-failed callback — ensure the VM agent has valid auth for all lifecycle callbacks
- [ ] Add a workspace readiness timeout to the task runner (configurable, e.g., `WORKSPACE_READY_TIMEOUT_MS`)
- [ ] Add a test that verifies provisioning-failed callback auth works
- [ ] Task runner must not get stuck indefinitely when provisioning fails

## References

- `docs/notes/2026-03-12-same-zone-routing-postmortem.md`
- `apps/api/src/routes/workspaces.ts` — provisioning-failed handler
- `apps/api/src/durable-objects/task-runner.ts` — alarm-based state machine
