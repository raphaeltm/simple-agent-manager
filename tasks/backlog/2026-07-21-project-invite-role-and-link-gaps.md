# Project membership: role granularity + superseded invite-link gaps

## Problem

Discovered while documenting the collaboration/multiplayer feature (docs PR for
`guides/collaboration.md`). Two real gaps between the code and the intended UX:

### 1. Superseded invite links stay live but become un-revokable from the UI

`POST /api/projects/:id/invite-links` (`apps/api/src/routes/projects/members.ts`
~line 446) unconditionally inserts a new invite link and never revokes or
supersedes the previous active link. The schema has no uniqueness constraint on
`(projectId, revokedAt IS NULL)`. `ProjectMembersSection.tsx` (~line 322) then
surfaces only the single most-recently-created active link via `.find(status ==
'active')` and never renders the others. Net effect: clicking **New Link**
repeatedly leaves every prior link fully functional for anyone holding the old
URL, but the Members panel can no longer show or revoke those older links
individually. A user who "rotates" a link to cut off access has not actually cut
off anything.

Options: auto-revoke the prior active link when a new one is created (matches the
"one active link at a time" mental model), OR render all active links in the
panel so each can be revoked.

### 2. `maintainer` / `viewer` roles are defined but never assignable

`ProjectMemberRole` (`packages/shared/src/types/project.ts`) and
`PROJECT_MEMBER_ROLES` (`apps/api/src/middleware/project-auth.ts`) define
`owner | admin | maintainer | viewer`, and `ROLE_CAPABILITIES` gives
`maintainer`/`viewer` restricted capability sets. But the access-request approval
handler (`members.ts` approve handler) hardcodes `role: 'admin'`, and neither
`CreateProjectInviteSchema` nor `DecideProjectAccessRequestSchema` accepts a
role. So every approved teammate becomes a full admin; the restricted roles are
unreachable. The docs currently describe the real behavior (approval → admin),
but finer-grained membership is effectively unavailable despite existing in the
type system.

## Context

- Found: 2026-07-21, during the "document past-week user-facing changes" docs task.
- The docs (`guides/collaboration.md`) were written to match current reality
  (two effective roles, approval grants admin) and call out that finer-grained
  roles are "planned but not available yet."
- Design intent per project knowledge: small trusted teams where admins already
  have full access — so admin-on-approve is acceptable for v1, but the un-revokable
  superseded-link behavior is a real security-adjacent gap worth closing.

## Acceptance criteria

- [ ] Creating a new invite link either auto-revokes the previous active link OR the panel lists every active link with an individual revoke control (no silently-live, un-revokable links).
- [ ] Regression test: create link A, create link B, assert A is revoked (or still revocable from the panel).
- [ ] Decide whether `maintainer`/`viewer` should be assignable at approval time; if yes, add a role selector to the approve flow + schema; if no (v1), remove the unused roles or explicitly mark them as reserved/not-yet-used in a comment.
- [ ] If role selection ships, update `guides/collaboration.md` Roles section accordingly.
