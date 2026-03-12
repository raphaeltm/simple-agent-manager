# Bootstrap Token Endpoint Has Dual Auth (Unreachable)

**Date**: 2026-03-12
**Discovered during**: Callback auth middleware leak review (PR #325)
**Severity**: Low — endpoint appears to be dead code

## Problem

`POST /api/workspaces/:id/bootstrap-token` in `runtime.ts:490` has both `requireAuth()` as Hono inline middleware AND `verifyWorkspaceCallbackAuth()` in the handler body. These two auth mechanisms are mutually exclusive:
- Browser users have session cookies but no callback JWTs
- VM agents have callback JWTs but no session cookies

Neither caller can satisfy both checks, making the endpoint permanently unreachable.

## Acceptance Criteria

- [ ] Determine if this endpoint is used by any caller (check VM agent bootstrap code)
- [ ] If unused, remove the dead endpoint
- [ ] If used, fix the auth to match the actual caller (remove one of the two auth checks)

## References

- `apps/api/src/routes/workspaces/runtime.ts:487-513`
- `packages/vm-agent/internal/bootstrap/bootstrap.go`
