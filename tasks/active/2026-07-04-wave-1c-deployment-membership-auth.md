# Wave 1C Deployment Membership Auth

## Problem Statement

Deployment and infrastructure project routes still gate project access through `requireOwnedProject()`, so active project admins cannot see or manage shared project deployment resources. Wave 1C migrates only the deployment/infrastructure route family to membership and capability authorization while preserving `userId` as actor, credential, and audit attribution.

## Scope

- Migrate only:
  - `apps/api/src/routes/deployment-custom-domains.ts`
  - `apps/api/src/routes/deployment-environment-config.ts`
  - `apps/api/src/routes/deployment-environment-lifecycle.ts`
  - `apps/api/src/routes/deployment-environments.ts`
  - `apps/api/src/routes/deployment-releases.ts`
  - `apps/api/src/routes/deployment-secrets.ts`
  - `apps/api/src/routes/deployment-volumes.ts`
  - `apps/api/src/routes/project-deployment.ts`
- Do not migrate sibling project/chat/task/workspace or automation/context route families.
- Do not change credential attribution or deployment node ownership semantics in this wave.

## Research Findings

- Membership foundation is present in `apps/api/src/middleware/project-auth.ts` with `requireProjectAccess()` and `requireProjectCapability()`.
- Admin members have every project capability except `project:delete`; this matches v1 shared-project UX decisions where owner and admin are effectively full access except owner-only project deletion and transfer.
- Existing deployment routes use `requireOwnedProject()` only as the project authorization gate. Many helpers still use `userId` for actor attribution or user-scoped cloud/node/registry credentials and should remain unchanged in Wave 1C.
- Read-oriented deployment routes should require project membership visibility (`requireProjectAccess()` or `deployment:read` where capability is clearer).
- Writes should use focused capabilities: `deployment:deploy` for release submission, `deployment:manage` for environments/custom domains/volumes/lifecycle/destructive operations, `secret:read`/`secret:write` for deployment secrets/runtime config, and `infra:manage` for GCP backing deployment infrastructure credential setup/removal.
- The deployment identity token route is MCP-token authenticated and not a session membership route; its project check remains token-project matching. The GCP OAuth callback does need membership/capability validation after state validation.
- Hono middleware leak postmortems require keeping per-route auth and not introducing wildcard middleware.

## Implementation Checklist

- [ ] Replace `requireOwnedProject()` imports and calls in the eight scoped route files with `requireProjectAccess()` or `requireProjectCapability()` using route-appropriate capabilities.
- [ ] Preserve current `userId` usage for created-by/audit fields, OAuth state identity, deployment provisioning, image resolution, node proxy calls, and credential/node service calls.
- [ ] Update route comments that describe owner-only authorization where touched.
- [ ] Add focused route tests proving an active admin member can access representative migrated deployment routes and a non-member is rejected.
- [ ] Run a grep check proving no `requireOwnedProject` usage remains in the eight scoped files.
- [ ] Run relevant API/unit tests and broader quality gates required by `/do`.
- [ ] Run specialist reviews required for API/auth/credential-sensitive changes.
- [ ] Open PR for `sam/wave-1c-migrate-deployment-01kwpm`, wait for CI, perform required staging verification if not blocked, and merge if gates pass.

## Acceptance Criteria

- Active admin members can access representative deployment read and write routes for projects they do not own.
- Non-members are rejected from migrated deployment routes.
- Deployment secret/runtime-config routes use secret capabilities.
- Deployment release submission uses deploy capability.
- Environment lifecycle, custom domain, volume, destructive environment, and deployment infrastructure management routes use management capabilities.
- Existing actor/audit/credential attribution remains based on the active session user.
- No `requireOwnedProject` call sites remain in the eight scoped files.

## References

- SAM idea `01KVX4YP9C5255TEB28PGM1159`
- `apps/api/src/middleware/project-auth.ts`
- `tasks/archive/2026-07-01-project-membership-foundation.md`
- `tasks/archive/2026-03-25-deployment-identity-token-middleware-leak.md`
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/35-vertical-slice-testing.md`
