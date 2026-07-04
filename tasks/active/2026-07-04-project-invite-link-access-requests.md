# Project invite-link access requests

## Problem Statement

Shared-project membership authorization is now available on `main`, but users still have no production flow to invite teammates into a project. Wave 2 needs a link-based request flow: active project members can create invite links, recipients request access, and owners/admins approve or deny after verifying the recipient's own GitHub repo access.

No email delivery is in scope. Membership approval must not allow a user to operate through another member's GitHub identity, and owner-only project deletion/ownership boundaries must stay unchanged.

## Research Findings

- `apps/api/src/middleware/project-auth.ts` defines active membership, roles, and capabilities. `admin` has `member:manage`; `owner` has all capabilities; `admin` intentionally lacks `project:delete`.
- `apps/api/src/routes/projects/index.ts` mounts project subroutes behind session auth/approval. New member routes can live under this router, but must use per-route project capability helpers for member mutation.
- `apps/api/src/routes/projects/_helpers.ts` already has `requireRepositoryUserAccess()` and `requireRepositoryOwnerAccess()` built around `assertRepositoryAccess()`, `requireGitHubUserAccessToken()`, and user-context GitHub repo listing. Invite approval must use the invitee's user token, not the inviter's or approver's token.
- `apps/api/src/db/schema.ts` currently has `project_members` but no invite link or access request tables. Additive D1 migrations are safe here; do not recreate `projects` or `project_members`.
- Existing shared API response types are in `packages/shared/src/types/project.ts`, and the web API client for project settings lives in `apps/web/src/lib/api/projects.ts`.
- `apps/web/src/pages/ProjectSettings.tsx` is the real settings surface. A new member-management section should follow the existing dense settings-section style and avoid prototype routes.
- Prior GitHub access task records (`tasks/archive/2026-06-07-enforce-user-app-repo-access-intersection.md`, `tasks/archive/2026-05-08-verified-shared-github-installations.md`) establish the security invariant: GitHub repo access is user-scoped and must be checked with the signed-in user's OAuth token and the app installation intersection.
- UI changes require Playwright visual audits on mobile and desktop with normal, long-text, empty, many-item, error, and special-character data.

## Implementation Checklist

- [ ] Add D1 schema and migration for project invite links and project access requests with explicit expiry, revocation, status, requester, approver, and GitHub access status fields.
- [ ] Add shared types and API client methods for invite creation, invite lookup/request, pending member/request listing, approval, denial, and revocation.
- [ ] Add project member/invite API routes under `apps/api/src/routes/projects`:
  - [ ] Any active member can generate a link.
  - [ ] Authenticated non-members can request access through a valid unexpired/unrevoked link.
  - [ ] Active project members can list current members as needed for settings display.
  - [ ] Owners/admins can list pending requests and approve/deny them via `member:manage`.
  - [ ] Approval inserts/updates an active admin membership for the requester and records the decision.
  - [ ] Expired/revoked links reject new requests.
- [ ] Verify/flag the requester's GitHub repo access using the existing user∩app helper path. If exact verification is unavailable in a specific state, persist and surface a clear status instead of widening access.
- [ ] Preserve owner-only project deletion and ownership-transfer boundaries; do not grant `project:delete` through admin approval.
- [ ] Add focused API tests for happy path, non-member request, non-admin approval denial, admin approval success, denied request, revoked/expired link, and GitHub access status handling.
- [ ] Add `ProjectMembersSection` to the real project settings page using existing components/styles, including invite link creation/copy/revoke, pending request approval/denial, current member display, and GitHub access status.
- [ ] Add UI behavior tests for new member-management interactions and a Playwright visual audit covering mobile/desktop edge cases.
- [ ] Run relevant validation, specialist reviews, staging verification, PR creation, CI, merge, and production deploy monitoring per `/do`.

## Acceptance Criteria

- Any active project member can create a reusable invite link with clear expiry/revocation semantics.
- Opening a valid invite link lets an authenticated non-member request access; it does not auto-join.
- Owners and admins can approve or deny pending requests; other members cannot approve.
- Approved users become active project admins and can access member-authorized project routes, but admins still cannot delete the project.
- Approval/request handling verifies or prominently flags the invitee's own GitHub repository access without using another member's credentials.
- Denied, expired, and revoked invite states are enforced by the API and represented clearly in the UI.
- The production project settings/member surface works on mobile and desktop with no horizontal overflow.
- Focused API, UI, and visual-audit tests pass, followed by full `/do` validation and staging verification.

## References

- SAM task `01KWPZEP9KSM72K5924SM5ZSGT`
- Idea `01KVX4YP9C5255TEB28PGM1159`
- `apps/api/src/middleware/project-auth.ts`
- `apps/api/src/routes/projects/_helpers.ts`
- `apps/api/src/services/github-app.ts`
- `apps/web/src/pages/ProjectSettings.tsx`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
