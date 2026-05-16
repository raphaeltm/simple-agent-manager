# Fix Git Credential Callback Auth

## Problem

Workspace git operations can fail because the devcontainer git credential helper receives `HTTP 401` from the VM agent `/git-credential` endpoint even when the helper contains a valid workspace-scoped callback JWT. The current VM-agent validation path compares the bearer token byte-for-byte against in-memory callback-token strings. If the per-workspace runtime token is missing, stale, or not byte-identical, a valid workspace JWT is rejected.

The same debug package also contains repeated host cron messages saying `Authentication token is no longer valid; new one required`. That is a separate PAM/root-password-expiry issue, not GitHub authentication, but it pollutes investigations and may prevent root cron jobs such as the Cloudflare firewall refresh from running.

## Research Findings

- `packages/vm-agent/internal/server/git_credential.go` handles `/git-credential` and calls `isValidCallbackAuth()`.
- `isValidCallbackAuth()` currently does raw string comparison against `s.config.CallbackToken` and `callbackTokenForWorkspace(workspaceID)`.
- `callbackTokenForWorkspace()` in `workspace_provisioning.go` falls back to the node callback token when `runtime.CallbackToken` is missing.
- The server already has a JWT validator; `server.go` contains `isValidWorkspaceToken()` that validates a workspace token cryptographically against a workspace ID.
- `persistWorkspaceMetadata()` does not persist `CallbackToken`, so VM-agent restart or runtime rehydration can lose the per-workspace token.
- `packages/cloud-init/src/template.ts` has no `chpasswd` entry, but debug logs show cloud-init runs `passwd --expire root`. Add an explicit runcmd mitigation to unlock root cron account checks.
- Relevant postmortems:
  - `docs/notes/2026-03-06-heartbeat-token-expiry-postmortem.md`
  - `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`
  - `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
  - `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`
- Uploaded investigation: `/workspaces/.private/2026-05-15-git-credential-401-investigation.md`.

## Implementation Checklist

- [x] Update `/git-credential` auth to accept cryptographically valid workspace-scoped JWTs for the requested workspace, with raw string comparison retained as fallback.
- [x] Add safe structured logging for rejected git-credential auth attempts without exposing token values.
- [x] Persist and hydrate per-workspace callback tokens in VM-agent SQLite metadata without storing plaintext tokens.
- [x] Add Go tests for valid workspace JWT without runtime token, wrong-workspace JWT rejection, raw fallback acceptance, and persistence/hydration of callback tokens.
- [x] Add cloud-init mitigation for expired root password/account state so root cron jobs can run.
- [x] Add cloud-init tests proving the mitigation exists and runs before VM-agent startup.
- [x] Run focused package tests and full quality checks.
- [x] Deploy to staging and verify with a real VM/workspace that git credential helper auth succeeds.
- [ ] Merge and monitor production deployment.

## Acceptance Criteria

- A valid workspace-scoped callback JWT authorizes `/git-credential?workspaceId=<id>` even if `runtime.CallbackToken` is unavailable.
- Tokens for the wrong workspace are rejected.
- Existing raw-token fallback behavior remains compatible.
- Rejections are diagnosable from VM-agent logs without leaking token material.
- Workspace callback token survives VM-agent metadata persistence and hydration without plaintext SQLite storage.
- Fresh VMs do not emit root cron PAM failures due to an expired root password/account token.
- Staging verification provisions a real VM/workspace and confirms credential-helper behavior before merge.

## Staging Verification

- Staging deploy run `25907732700` completed successfully, including smoke-tests.
- Fresh staging workspace: `01KRNBV6GA08V7SSM04DR77CFP`; node: `01KRNBV62BCC21F4YYTC5NZQF6`.
- Node heartbeat arrived at `2026-05-15T08:27:54.389Z`; workspace reached `running` at `2026-05-15T08:31:30.882Z`.
- Terminal WebSocket access succeeded. Inside the workspace, `git ls-remote origin HEAD` exited `0` and returned `14eee07a2b6d11573e7dede996c359cb5c511a71 HEAD`.
- Debug package downloaded to `/workspaces/.private/staging-debug-01KRNBV62BCC21F4YYTC5NZQF6.tar.gz`; grep found no `Authentication token is no longer valid`, no `pam_unix(cron:account)`, and no `Git credential auth rejected` lines.
- Staging verification node was deleted after testing.
