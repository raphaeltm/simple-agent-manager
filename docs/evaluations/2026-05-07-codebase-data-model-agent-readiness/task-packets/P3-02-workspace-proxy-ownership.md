# P3-02: Workspace Proxy Ownership Check

**Phase**: 3 (Security & Data Integrity)
**Priority**: P0
**Risk Level**: High — modifies authentication/authorization
**Effort**: S (4-8 hours)
**Source Findings**: F-002 (Track 7: Security)
**Recommended Skill(s)**: `$security-auditor`, `$test-engineer`
**BLOCKED**: Until Phase 2 testing foundation is in place and human reviews this plan

## Scope

Workspace subdomain proxying (`apps/api/src/index.ts`) must verify that the authenticated user owns the target workspace. Currently, any authenticated user may be able to proxy to any workspace subdomain.

## Files Likely Touched

- `apps/api/src/index.ts` — add ownership verification to proxy path
- Workspace ownership helpers (new or existing) — utility to check `workspace.userId === authenticatedUser.id`
- `apps/api/tests/` — regression tests for same-user allow and cross-user deny

## Compatibility Constraints

- Must not break existing workspace access for legitimate owners
- Admin-only behavior, if any, must be explicit and tested
- Must handle edge cases: workspace in transitional states, deleted workspaces

## Automated Tests to Add/Run

- Test: authenticated user who owns workspace → proxy allowed
- Test: authenticated user who does NOT own workspace → proxy denied (403 or 404)
- Test: unauthenticated request → denied (existing behavior)
- Test: admin user access pattern (if applicable) → explicitly tested
- `pnpm --filter @simple-agent-manager/api test`

## Manual Staging Verification

- Log in as User A, attempt to access User B's workspace subdomain
- Verify 403/404 response (not proxy pass-through)
- Log in as User A, access own workspace → verify proxy works

## Expected Current Staging State Dependency

- At least two users with workspaces on staging

## Expected Post-Deploy State

- Workspace subdomain proxy rejects authenticated users who don't own the workspace
- Legitimate workspace access unchanged

## Visible Behavior Changes

- Users who somehow navigated to another user's workspace URL will now get an error instead of access
- No change for users accessing their own workspaces

## Rollback Notes

- Revert the ownership check in `index.ts`. This re-introduces the security vulnerability.
- **Risk**: Rollback removes an authorization check. Only rollback if the check itself is broken (blocking legitimate access).

## Acceptance Criteria

- [ ] Proxy path rejects authenticated users who do not own the workspace
- [ ] Admin-only behavior, if any, is explicit and tested
- [ ] Regression tests cover same-user allow and cross-user deny
- [ ] Security review before PR merge
- [ ] `pnpm --filter @simple-agent-manager/api test` passes

## Links

- Track report: `tracks/07-security-isolation.md` (HIGH-1: Workspace Proxy Bypass)
- Finding: F-002 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 1, Task 1B
- Code: `apps/api/src/index.ts` (workspace subdomain proxy section)
