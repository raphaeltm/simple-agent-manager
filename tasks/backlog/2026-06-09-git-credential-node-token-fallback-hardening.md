# Harden node-level callback-token fallback for workspace-specific git-token exchange

**Origin:** MEDIUM finding from `security-auditor` during Phase 5 review of the
secondary-workspace git-credential gate fix
(`tasks/archive/2026-06-09-fix-secondary-workspace-git-credential-gate.md`,
SAM idea `01KTN1VGPM7Z3Z4YRHJ0JJJ5YZ`).

## Problem

`callbackTokenForWorkspace(workspaceID)` (`workspace_provisioning.go:28-36`) resolves the
token to forward to the control plane with a two-tier fallback: the per-workspace
`runtime.CallbackToken` first, then `s.config.CallbackToken` (the node-level token). If a
secondary workspace is registered in the runtime map but its `CallbackToken` is empty
(e.g. a registration bug), a workspace-specific git-token exchange
(`POST /api/workspaces/<wsid>/git-token`) would forward the node-level token instead of a
per-workspace token.

This is **pre-existing** (the same fallback applied to the primary workspace before the
gate fix) and **bounded** — the control plane independently verifies token↔workspace
ownership, and the existing guard at `git_credential.go:91` fails fast when BOTH the
per-workspace and node-level tokens are empty. The secondary-workspace gate fix makes this
fallback reachable for secondary workspaces too, so it is worth making observable.

## Fix

- Emit a `slog.Warn` when `callbackTokenForWorkspace` falls through to the node-level
  token for a workspace-specific request, so misconfigured secondary-workspace
  registrations are visible in `journalctl` instead of silently succeeding. Scope the
  warning so it does NOT fire for the legitimate single-workspace/primary path (avoid
  observability noise — see `pnpm quality:observability-noise`).
- Add a test where a registered secondary workspace has an empty `CallbackToken` and
  assert the observable behavior (warning emitted / fail-fast as decided).
- Add a multi-workspace test (using `newTwoWorkspaceGitCredentialServer`) for the
  empty-`workspaceId` loopback case asserting it resolves to the primary's token/path.

Note: the deferred per-container binding follow-up
(`2026-06-09-git-credential-loopback-container-binding.md`) substantially reduces the
blast radius of this and may be implemented together.

## Acceptance Criteria

- [ ] Node-level token fallback for a workspace-specific request is observable (warn log) without noise on the legitimate primary/single-workspace path
- [ ] Test: registered secondary workspace with empty callback token — asserted behavior
- [ ] Test: empty-`workspaceId` loopback on a multi-workspace node resolves to primary
- [ ] `pnpm quality:observability-noise` passes

## References

- `packages/vm-agent/internal/server/workspace_provisioning.go` (`callbackTokenForWorkspace`)
- `packages/vm-agent/internal/server/git_credential.go` (`fetchGitTokenResponseForWorkspace`)
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
