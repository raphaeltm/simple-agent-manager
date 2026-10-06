# Fix GitHub auth on secondary workspaces (delete primary-workspace gate)

**SAM idea:** `01KTN1VGPM7Z3Z4YRHJ0JJJ5YZ`
**Priority:** TOP — ship to production.

## Problem

GitHub auth (git + `gh`) is broken for agents running on **secondary** workspaces of
multi-workspace warm-pool nodes. Only the node's "primary" workspace
(`s.config.WorkspaceID`, fixed at provisioning) can refresh a git token via the
in-container credential helper. Every secondary workspace created later by reusing
the warm node is silently denied with 401, so agents on those workspaces cannot
clone, fetch, push, or use `gh`.

Directive: all workspaces must be treated equally. Tokens stay tightly scoped
(per-workspace, single-repo, ~1h TTL, owner-scoped), but every workspace running
on the node must be able to refresh its own token for as long as it is running.

## Root Cause

Two hardening commits combined to create the regression:

1. `d68bc0c5` ("harden git credential workspace exchange") — planted a
   **primary-only gate** (`isPrimaryWorkspaceGitCredentialRequest`).
2. `5dce7bce` ("Harden GitHub token injection authorization boundary") — removed
   the bearer token from the in-container credential helper
   (`renderGitCredentialHelperScript`) and stopped persisting a static `GH_TOKEN`.
   With no bearer token, every helper request now falls to the loopback branch of
   `isAuthorizedGitCredentialRequest`, which is gated to the primary workspace only.

`packages/vm-agent/internal/server/git_credential.go`:

```go
func isAuthorizedGitCredentialRequest(s *Server, r *http.Request, workspaceID string) bool {
    if bearerTokenFromHeader(r.Header.Get("Authorization")) != "" {
        return s.isValidCallbackAuth(r, workspaceID)
    }
    // helper sends NO bearer token => always lands here
    return isLocalGitCredentialExchange(r) && isPrimaryWorkspaceGitCredentialRequest(s, workspaceID)
}
```

The in-container helper deliberately omits the callback token; it asks the VM agent
to perform the control-plane exchange using its in-memory per-workspace callback.
So the only gate a secondary workspace hits is the primary check, which rejects it.

## Research Findings

- **The registry pattern is already the right approach.** `callbackAuthCandidates`
  (bearer branch) already pulls the per-workspace token via `getWorkspaceRuntime`.
  The loopback branch should use the same registry lookup.
- **`getWorkspaceRuntime(workspaceID)`** (`workspace_routing.go:157`) returns
  `(*WorkspaceRuntime, ok)` keyed on map presence. Entries are added on workspace
  creation (`workspace_routing.go:311`, `server.go:480`) and removed ONLY on
  workspace deletion (`removeWorkspaceRuntime`, called from `workspaces.go:735`).
  So map presence == "workspace currently exists/runs on this node" — exactly the
  signal we need.
- **The primary workspace is in config (`s.config.WorkspaceID`)** and is also
  registered in the map at startup (`server.go:480`), but to be safe we keep the
  explicit primary check so single-workspace host mode (where the map may be empty)
  is unchanged.
- **The `gh` wrapper + dynamic `GH_TOKEN` fallback already exist**
  (`bootstrap.go: installGhWrapper`, shell startup) and both depend on this same
  helper. Fixing the gate fixes BOTH git and `gh` on secondary workspaces — no
  bootstrap changes needed.
- **Existing test `TestHandleGitCredentialRejectsLocalExchangeForNonPrimaryWorkspace`**
  asserts the OLD (buggy) behavior: a registered secondary workspace loopback
  request returns 401. This test must be rewritten to assert the NEW behavior
  (registered secondary → 200) and a NEW test added for unregistered → 401.

## Fix

In `packages/vm-agent/internal/server/git_credential.go`:

1. Replace the loopback branch's `isPrimaryWorkspaceGitCredentialRequest(s, workspaceID)`
   call with a new `isKnownWorkspaceGitCredentialRequest(s, workspaceID)`.
2. `isKnownWorkspaceGitCredentialRequest`: trim/resolve the requested workspace id
   (default empty → primary), return false if still empty, return true if it equals
   the primary, else return true iff `getWorkspaceRuntime(requestedWorkspaceID)`
   reports the workspace is registered on this node.
3. **Delete** `isPrimaryWorkspaceGitCredentialRequest`.

### Why this stays secure

- Tokens remain per-workspace, single-repo, ~1h TTL, owner-scoped — the
  control-plane exchange (`/api/workspaces/<wsid>/git-token`) is unchanged.
- The loopback branch is reachable only from inside the node
  (`isLocalGitCredentialExchange`, loopback/private IP).
- The bearer-token branch (remote callers) is unchanged — still requires a valid
  per-workspace callback token or workspace callback JWT.
- An unregistered/unknown workspace id on the loopback path is still rejected.

### Defense-in-depth follow-up (NOT in this PR)

Option B: bind a loopback request to the calling container's own workspace so a
loopback caller cannot request a token for a *different* registered workspace.
Acceptable to defer given loopback-only access + per-workspace scoping. File as a
backlog item.

## Implementation Checklist

- [x] Add `isKnownWorkspaceGitCredentialRequest(s *Server, workspaceID string) bool`
- [x] Switch loopback branch of `isAuthorizedGitCredentialRequest` to use it
- [x] Delete `isPrimaryWorkspaceGitCredentialRequest`
- [x] Rewrite `TestHandleGitCredentialRejectsLocalExchangeForNonPrimaryWorkspace`
      → now `TestHandleGitCredentialAllowsLocalExchangeForRegisteredSecondaryWorkspace`:
      registered secondary workspace loopback request returns 200 and hits
      control plane with the secondary's callback token
- [x] Add test: loopback request for an UNREGISTERED workspace id → 401, control
      plane NOT called (`TestHandleGitCredentialRejectsLocalExchangeForUnregisteredWorkspace`)
- [x] Add test: loopback request with empty workspaceId still maps to primary → 200
      (covered by `TestHandleGitCredentialAllowsLocalExchangeWithoutCallbackBearer`)
- [x] Run `go test ./...` in `packages/vm-agent` — all packages pass, vet clean
- [x] Grep docs for any "primary workspace" git-credential references; none stale
      (blog journal is a historical narrative, no gate claims)

## Acceptance Criteria

- [x] `isPrimaryWorkspaceGitCredentialRequest` no longer exists
- [x] Loopback credential auth authorizes ANY workspace registered on the node
      (primary or secondary), rejects unregistered ones
- [x] Secondary-workspace git token refresh works (verified by test; staging pending Phase 6)
- [x] `gh` CLI works on secondary workspaces (relies on same helper — same gate)
- [x] Same-org submodule clone still works (bearer-token path unchanged)
- [x] Tokens remain per-workspace, single-repo, ~1h, owner-scoped (control-plane exchange unchanged)
- [x] Tests cover secondary / unregistered / empty-workspaceId cases
- [ ] Shipped to production (pending Phase 6 staging + Phase 7 merge/deploy)

## Phase 5 Review Outcomes (2026-06-09)

- **task-completion-validator**: PASS. 1 LOW — file the deferred Option B backlog item.
  Done: `tasks/backlog/2026-06-09-git-credential-loopback-container-binding.md`.
- **go-specialist**: PASS, no blocking findings. 1 LOW suggestion to collapse the two
  auth branches into a single `getWorkspaceRuntime` lookup. Intentionally NOT applied:
  the explicit primary check is deliberate (keeps single-workspace host mode unchanged
  when the runtime map is empty), per the Research Findings above.
- **security-auditor**: PASS, 0 CRITICAL/HIGH. 1 MEDIUM (node-level callback-token
  fallback for a workspace with an empty per-workspace token — pre-existing, not a
  regression, bounded by control-plane ownership checks) + 2 LOW. Deferred to backlog
  with justification: `tasks/backlog/2026-06-09-git-credential-node-token-fallback-hardening.md`.

## References

- `.claude/rules/34-vm-agent-callback-auth.md` (VM agent callback auth boundaries)
- `.claude/rules/27-vm-agent-staging-refresh.md` (delete nodes before staging VM-agent tests)
- `.claude/rules/02-quality-gates.md` (credential resolution test requirements)
- `.claude/rules/28-credential-resolution-fallback-tests.md`
