# Staging lease: fair queue, and keep migration branches off primary staging

SAM task `01M7HK7TY9GA8DTV3BGS4QYNM8`, idea `01M7FYGMEESYH3AJZJ0CT3NKCZ`. Fixes defects in the lease
approved on 2026-11-15 (PR #2762, extended by #2766).

## Problem

First night of use (idea notes, 2026-11-16):

1. No queue: at release or expiry the slot goes to whoever dispatches first (task
   01M7G55K6BSR1RPMZK14CAD8KE lost three hand-offs; 01M7GY0BKP1WESE5Y82PZNN42S released early as a
   favour and then lost every hand-off for hours).
2. Silent loss of place: the workflow-level concurrency group keeps one pending run, so a dispatch
   made while a deploy runs can be cancelled by a later dispatch (run 43794216077).
3. A holder can release and immediately re-acquire while others wait.
4. Draft PR #2721 deployed DO migration tag v23 on primary staging (main at v22); the migration
   preflight then fails closed for every main-based branch.

## Research findings

- `scripts/deploy/staging-lease.mjs` reads only `records[0]` (`per_page=1`) of task `staging-lease`
  and fails closed unless `version === 1` and the v1 fields validate. Mutations run in job `lease` of
  `.github/workflows/deploy-staging.yml`, serialized by the **workflow-level** group
  `deploy-<env>` (cancel-in-progress false). The whole deploy (~7-30 min) runs inside that group, so
  any dispatch made meanwhile is a long-lived pending run that the next dispatch cancels.
- GitHub deployments have no compare-and-set; serialization needs a concurrency group, and a group
  keeps at most one pending run. Appending a new deployment record needs no serialization: ids are
  monotonic.
- `scripts/quality/deploy-staging-permissions.test.ts` pins: workflow-level group, only job `lease`
  has `deployments: write`, every other job `needs: lease`.
- Old-workflow branches (copy of `staging-lease.mjs` from #2762/#2766) refuse any latest record that
  is not v1: "Malformed lease record". Pre-#2762 branches have no lease job at all (pre-existing gap).
- DO migration tags: `apps/api/wrangler.toml` `[[migrations]]` (`tag = "vN"`), checked by
  `scripts/deploy/durable-object-migrations.ts` at deploy time.

## Design (part 1)

- Records stay deployments with task `staging-lease`; payload `version: 2`.
  - `kind: "reservation"` events are append-only (`branch`, `taskId`, `reservedAt`, `expiresAt`).
    Written by a new `queue` job that has **no concurrency group**, so they can never be cancelled
    or lost.
  - `kind: "snapshot"` records are written only by the serialized `lease` job: `holder`,
    `freeSince`, `promisedAt`, ordered `queue`, `seenThrough` (highest record id read).
  - State = newest snapshot (or legacy v1 record) + reservation events with id > `seenThrough`.
- Turns: while free, queue entry 0 may take the slot from `max(freeSince, reservedAt)` until
  `max(that, promisedAt) + grace` (`promisedAt` = the released holder's announced expiry, so an early
  release never shortens the head's turn); each next entry gets `grace` after the previous window.
  Missed windows drop the entry. Reservations older than the reservation TTL are skipped. With an
  empty queue, anyone may acquire.
- `queue` job: appends a reservation unless the branch holds the lease or is already queued
  (`reserve` always appends, renewing the TTL); lets the run into the `lease` job only if the branch
  holds the lease or it is its turn; otherwise fails (deploy/acquire) or succeeds (reserve) with the
  position in the step summary.
- `lease` job uses group `staging-lease-<env>` (not the `deploy-<env>` group old copies hold, so their
  pending runs cannot displace an entitled one); deploy/storage-activation/agent-email audit move to
  group `staging-apply-<env>`. A release enters the group only if the branch holds or is queued.
- The lease job honours the turn the queue job saw (`checked_at`, bounded to 3 grace periods), so a
  runner or group wait cannot cost the head its turn. An expired holder may re-reserve.
- Release removes the branch's hold and its reservation; re-acquiring means queueing at the back.
- Old workflows: any v2 record on top fails their lease job closed — no deploy, acquire, release.
  Payload `notice` tells them to update from main.
- Malformed snapshot or unknown version → fail closed (as #2762). Malformed reservation event → skipped
  and reported (it can only add an entry).
- `node scripts/deploy/staging-lease.mjs status <env>`: one `gh api` call, prints holder + queue
  with windows. Raw read: `gh api .../deployments?environment=<env>&task=staging-lease&per_page=100`.

## Checklist — Part 1 (PR 1)

- [x] Pure queue state + decision module with tests (empty queue, two waiters in order, head misses
      grace, holder re-queues behind waiters, reservation expiry, concurrent reservations, legacy
      record, malformed records, early release keeps head's turn)
- [x] `staging-lease.mjs`: `queue` and `lease` phases, `status` command
- [x] Workflow: `reserve` action, `queue` job outside group, `lease` job group, apply group; grace
      and reservation TTL vars
- [x] Permissions/gating test updated
- [x] Docs: `.claude/commands/do.md`, `.agents/skills/do/SKILL.md`, `.claude/rules/13-staging-verification.md`,
      `.agent-instructions/reference/rules/13-staging-verification-full.md`
- [x] Live proof with two branches (reserve/acquire/release, no full deploys) — on primary `staging`, staging2 was held
- [x] Deploy path through queue → lease → deploy proven: dry_run deploy 43901912468 on primary staging (both installations were continuously held by pre-queue branches; staging2 never freed)
- [x] Channel `feature.ship-faster` updated at each take/release and at merge; idea note after part 2 merges

## Checklist — Part 2 (PR 2, after PR 1 merges)

- [x] Refuse `staging` deploys of a branch whose `apps/api/wrangler.toml` has a DO migration tag
      `origin/main` lacks; fail closed if the comparison can't be made; message says use `staging2`
- [x] Tests in the existing deploy-script test suite (`staging-migration-guard.test.mjs`, run by `deploy-staging-permissions.test.ts`)
- [x] Docs: clean-up duty (teardown + redeploy main on staging2 before release)
- [ ] Tell #2721 owner (task 01M7C1SRMAWR3PYFWKF03XJ273) — on merge of part 2 (#2721 itself merged 2026-11-16 08:11Z, so primary's v23 state already cleared)

## Acceptance criteria

- Reserve without deploying in seconds; read holder and ordered queue with one `gh api` call.
- Only the head may take a freed slot during its grace; then the next; releasing holder goes behind
  existing waiters; stale reservations expire.
- No dispatch can cancel another agent's pending run or lose a reserved place.
- Old-workflow branches cannot jump the queue.
- Migration-carrying branches are refused on primary staging (part 2).

## Outcome

- Part 1: PR #2783, merged 2026-11-16 16:15Z (64a264da0).
- Part 2: Durable Object migration guard (`scripts/deploy/staging-migration-guard.mjs`) in the
  `queue` job of `deploy-staging.yml`. No production workflow touched.
