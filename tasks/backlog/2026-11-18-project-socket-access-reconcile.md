# Reconcile open project WebSockets against current project access

## Problem

PR #2867 closes a user's project WebSockets when offboarding or admin suspension revokes their
access (`closeBrowserSocketsForActor`, `apps/api/src/services/project-socket-revocation.ts`). The
close is one RPC made after the revocation commits. Gaps that remain:

1. **Failed close.** If the DO RPC fails, offboarding only logs `project_sockets.close_failed`
   (it cannot be re-applied once the member is removed). Suspension answers 503 so the admin can
   retry, but nothing retries on its own.
2. **Admission race.** An upgrade whose membership check ran just before the revocation's D1
   write, and whose DO admission happens just after the close RPC, stays open.
3. **Sign-out and session revocation** do not close sockets (stolen-cookie scenario only; no
   cross-user boundary).
4. **Sibling long-lived sockets** have the same shape and no close on revocation:
   - NotificationService `/ws` (`apps/api/src/routes/notifications.ts`) after suspension;
   - admin log streams (`apps/api/src/routes/admin/observability.ts`, `admin-logs`) after a
     superadmin is demoted.

## Context

Found by the security-auditor and cloudflare-specialist reviews of PR #2867 (SAM task
`01M7PX499FF397BR3VWYTD3HQT`), all rated MEDIUM/LOW and explicitly recommended as a follow-up.

## Proposed shape

A ProjectData alarm section, active only while browser sockets are open: read the distinct
`actor:` tags, run one batched D1 query for active membership and non-suspended account status,
close the rest with 4403. One D1 query per object per tick, only when sockets exist (rules 47, 57,
60). Interval env-configurable with a `DEFAULT_*` constant.

## Acceptance Criteria

- [ ] A socket left open after a failed close is closed within one reconcile interval
- [ ] A socket admitted in the admission race is closed within one reconcile interval
- [ ] A member who stays is never closed (control), and an object with no open sockets does no
      D1 read
- [ ] Tests drive the real alarm with seeded sockets (rules 53, 62)
- [ ] Decide and implement the NotificationService and admin-log socket behaviour on suspension
      and demotion
