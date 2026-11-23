# Suspension retry must reach memberships removed after a failed close

## Problem

Late CodeRabbit finding on merged #2867 (discussion r4612988073). `closeSuspendedUserSockets`
(`apps/api/src/services/project-socket-revocation.ts`) chose close targets with
`status = 'active'`. If suspension's close on a project failed (503, "suspend again"), and
offboarding then removed that membership with its own close also failing (it only logs), the
admin's retry skipped the project and returned success. The suspended, removed user's socket on
that project stayed open.

## Plan and acceptance

- [x] Close targets: active memberships plus memberships removed since the suspension began
      (`removed_at >= since`). The admin route passes the original start on a retry: it reads the
      account before updating it and keeps the previous `updated_at` when the account is already
      suspended. Paging, user scoping and the bounded close concurrency are unchanged.
- [x] First version widened to every membership row; Codex (PR #2994, r4672460906) noted that
      historical rows grow without bound and a retry restarts from the beginning, so one request
      could exhaust its subrequest budget before reaching a later project. Bounding by the
      suspension start keeps the fan-out at the active rows plus the removals made while the
      account was suspended.
- [x] Real-SQLite unit regressions: retry after removal; only active and since-suspension removals
      are targeted (removed-before, invited and project-suspended rows are not; another user never);
      paging past the page size. Real Workers test through the admin route: injected close failure
      on one project (503), removal, retry (200) closes the remaining socket with 4403. The Workers
      test fails on the old predicate and when the route uses "now" as the retry epoch.
- [x] Docs: security architecture paragraph and the socket-reconcile backlog item.
- [ ] Review, exact-head CI, staging, merge, production deploy.

Work bound: one suspension reads the user's active memberships plus removals since the suspension
began, 100 per page, one close RPC per row, 10 at a time: the same fan-out the active-only query had,
plus the (normally zero to a few) memberships removed while suspended. No new tunable or migration.
