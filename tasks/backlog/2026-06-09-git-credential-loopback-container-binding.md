# Bind loopback git-credential requests to the calling container's own workspace

**Origin:** Deferred defense-in-depth follow-up from the secondary-workspace git-credential
gate fix (`tasks/archive/2026-06-09-fix-secondary-workspace-git-credential-gate.md`,
SAM idea `01KTN1VGPM7Z3Z4YRHJ0JJJ5YZ`). Raised by `task-completion-validator` and
`security-auditor` during Phase 5 review.

## Problem

After deleting the primary-only gate, `isKnownWorkspaceGitCredentialRequest` authorizes a
bearerless loopback credential exchange for ANY workspace currently registered on the
node. This is correct and bounded today (loopback/private-IP only, per-workspace
single-repo ~1h owner-scoped tokens, control-plane verifies token↔workspace ownership),
but it does NOT bind a loopback caller to its OWN workspace. In principle a loopback
caller inside container A could request a git token for a *different* registered
workspace B on the same node by passing `?workspaceId=<B>`.

Acceptable to defer because:
- The loopback branch is only reachable from inside the node.
- Tokens remain per-workspace, single-repo, ~1h TTL, owner-scoped.
- The control-plane exchange independently verifies the callback token belongs to the
  requested workspace.

## Fix (Option B)

Bind a bearerless loopback request to the calling container's own workspace so a loopback
caller cannot request a token for a different registered workspace. Likely approach:
resolve the caller's container/workspace from its source IP (Docker bridge IP →
workspace mapping already tracked in the runtime registry) and require the requested
`workspaceId` to match the caller's own workspace.

## Acceptance Criteria

- [ ] A loopback request originating from container A's IP cannot obtain a git token for
      a different workspace B registered on the same node (→ 401/403)
- [ ] A loopback request for the caller's own workspace still returns 200
- [ ] Empty-`workspaceId` requests still resolve to the caller's own workspace
- [ ] Tests cover: own-workspace allowed, cross-workspace rejected, empty-id resolves to caller
- [ ] Same-org submodule clone still works

## References

- `packages/vm-agent/internal/server/git_credential.go` (`isKnownWorkspaceGitCredentialRequest`, `isLocalGitCredentialExchange`)
- `packages/vm-agent/internal/server/workspace_routing.go` (`getWorkspaceRuntime`, IP→workspace mapping)
- `.claude/rules/34-vm-agent-callback-auth.md`
