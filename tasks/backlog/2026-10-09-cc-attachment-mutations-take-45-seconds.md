# Credential attachment create/delete takes 40–50 seconds

## Problem

Every `POST /api/cc/attachments` and `DELETE /api/cc/attachments/:id` on staging took 41–48 s of
wall time with under 1 s of CPU, so the time is spent waiting on I/O. A browser client with a 30 s
request timeout gives up before the server answers, and the row is created anyway. A retry can then
create a duplicate attachment: `POST` mints a new `cc-att-<ULID>` per request, and `cc_attachments`
has no uniqueness constraint on configuration, consumer, user and project.

Each handler awaits `reconcileCapacityPoolsForCredentialMutation`
(`apps/api/src/services/capacity-pool-credential-lifecycle.ts`). A `POST` with `projectId` reconciles
only that project. A `POST` without one, `PATCH` and `DELETE` use user scope, which reconciles the
user and every project with a compute attachment. Reconciliation runs even for agent-credential
attachments (`consumer_kind = 'agent'`), which cannot change any capacity pool. That this is where
the time goes is a hypothesis to confirm before fixing.

## Context

Found 2026-10-09 during staging verification for task `01M4EQEJ9PS6Q4MKBKE6FY2FMB` (Claude usage
limits), smoke user on `sam-api-staging`. Workers Observability for `/api/cc/attachments`:

| Time (UTC) | Method | Status | wallTimeMs | cpuTimeMs |
| ---------- | ------ | ------ | ---------- | --------- |
| 00:27:37   | DELETE | 200    | 48134      | 765       |
| 00:41:38   | POST   | 201    | 41259      | 340       |
| 00:46:01   | DELETE | 200    | 47303      | 423       |

An earlier POST at 2026-10-08 23:39 hit Playwright's 30 s client timeout. The row was still
created.

## Acceptance Criteria

- [ ] Measure where the time goes (D1 round trips, provider API calls) in the reconcile path for one
      attachment mutation.
- [ ] Agent-credential attachment mutations no longer wait on compute capacity-pool reconciliation,
      or the reconcile is bounded and moved off the request path (`ctx.waitUntil`) where correctness
      allows.
- [ ] Compute-credential attachment mutations still reconcile capacity pools (regression test).
- [ ] An attachment create/delete returns in under 2 s on staging, verified in Workers Observability.
