# Suspension retry must reach memberships removed after a failed close

## Problem

Late CodeRabbit finding on merged #2867 (discussion r4612988073). `closeSuspendedUserSockets`
(`apps/api/src/services/project-socket-revocation.ts`) chose close targets with
`status = 'active'`. If suspension's close on a project failed (503, "suspend again"), and
offboarding then removed that membership with its own close also failing (it only logs), the
admin's retry skipped the project and returned success. The suspended, removed user's socket on
that project stayed open.

## Plan and acceptance

- [x] Read close targets from every membership row of the user, whatever its status. Rows are
      never deleted (removal sets `status = 'removed'`), and a close where no socket is open is a
      no-op. Paging, user scoping and the bounded close concurrency are unchanged.
- [x] Real-SQLite regression: a failed first attempt, then removal, then a retry that must close
      the removed project; a scoping control (another user's membership is never targeted); and
      paging past the page size across all four statuses. Both fail on the old predicate.
- [x] Docs: security architecture paragraph and the socket-reconcile backlog item.
- [ ] Review, exact-head CI, staging, merge, production deploy.

Work bound: one suspension (rare, admin-triggered) reads the user's membership rows 100 per page
and makes one close RPC per row, 10 at a time. At a large outer limit of 1,000 rows (current plus
former memberships) that is 10 page reads and 100 waves of 10 RPCs, a few seconds in one request.
The previous query already paged through every active row the same way. No new tunable.
