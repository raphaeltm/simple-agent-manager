# Cleanup cron must finish tearing down idle GCP nodes (two-phase provider deletion)

SAM task `01M7C4ZYY7E0QGCX8KCD46JGGD`, idea `01M7C4MS211R0Y73CWPHK47B9K`, parent coordinator
task `01M7B399EN3X2YF5HVB5CJE3D3`. Output branch `sam/cleanup-cron-actually-finish-46jggd`.

## Problem

The stopped-node cleanup sweep claims an idle managed GCP node, gives the whole strict teardown 5 s
(`DEFAULT_NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS`), aborts, and records `destroy_failed`
"Stopped node cleanup request deadline exceeded". GCP teardown cannot fit: `GcpProvider.deleteVM`
looks the instance up, sends DELETE and then polls the operation (20 s to 2.4 min).

## Research findings (verified 2026-11-14, read-only)

1. **What removes these nodes in production today: the same cron, late.** Production
   `node_lifecycle_decisions` + `sam-prod-infra` GCP audit log:
   - `01M7B1WKTAF2RKBPP85GEM829S`: first attempt 22:35:59Z sent DELETE at 22:36:03.6Z (3.7 s in),
     VM gone 22:36:29Z; then 7 more attempts failed at the deadline while only confirming
     absence; proof written 23:11:00Z.
   - `01M76C7EGX3HMHZG4FY3M66X48`: DELETE only on the 4th attempt (02:50:58Z); proof 03:56:03Z.
   - `01M79R0X4R457JSN18HVFXZA2Q`: DELETE only at 09:50:56Z (35 min after the first failure), by
     the bounded stranded retirement; proof 09:55:50Z.
   So production does not leak VMs. It bills 0-35+ min of extra VM time before a DELETE gets
   out, then spends up to an hour failing to confirm absence. 117 error rows since 2026-11-07
   are that noise.
2. **Where the 5 s goes.** (a) `captureNodeLogsBeforeTeardown` runs first and has its own
   5 s timeout (`nodeLogCaptureTimeoutMs`), skipped after one capture per freshness window;
   (b) GCP token exchange; (c) `findGcpInstanceByIdOrName`: up to 8 sequential zone GETs then an
   aggregated list; (d) DELETE; (e) operation poll. On the #2715 fallback path (c) runs twice
   (ownership proof `getVM`, then `deleteVM`), so staging issued no DELETE at all.
3. **Measured GCP latencies** (read-only reader identity from a workspace, `sam-prod-infra`):
   token exchange ~0.2 s, zone GET 0.12-1.0 s each (8 zones ~2.5 s), aggregated list ~0.8-0.9 s,
   zone operations list ~0.15-0.18 s.
4. **GCP keeps delete operations queryable for days**: zone operations list with filter
   `(operationType = "delete") (targetId = "<instance id>")` returned exactly one op for an
   instance deleted 4 days earlier. A DONE op without error for that exact instance id is GCP's
   own record that the instance was deleted. Instance ids are unique per project.
5. **Per-provider deleteVM latency shape** (`packages/providers/src/*.ts`):
   | Provider | deleteVM | Waits for completion? |
   | --- | --- | --- |
   | Hetzner | one DELETE, 404 = gone | No (returns on accept) |
   | DigitalOcean | one DELETE | No |
   | Vultr | one DELETE | No |
   | Infomaniak | Keystone auth + DELETE | No |
   | Scaleway | zone search + `terminate` action | No |
   | UpCloud | GET + soft stop + `waitForState('stopped')` + DELETE + storage delete | Yes (stop wait) |
   | GCP | lookup (≤8 zone GETs + aggregated) + DELETE + operation poll | Yes (operation poll) |
6. **Callers of the stopped-handoff deadlines**: `sweepManagedHandoffNodes` (stopped + destroying
   phases), `sweepStrandedNodes` (bounded stranded retirement), `unhealthy-nodes.ts` release,
   `deployment-node-cleanup.ts`, `deployment-stop-recovery.ts`,
   `provider-orphan-reconciliation-core.ts`, `routes/deployment-environment-lifecycle.ts`.
7. **Starvation**: handoff candidates are ordered blocked-first (`cleanup_blocked_since ASC`), and
   a failure's refusal backoff is ≤ 5 min (`DEFAULT_CLEANUP_REFUSAL_WARN_AFTER_MS`) and 0 past the
   30-min deadline, so a page of permanently slow candidates is re-tried first every tick and
   valid work behind it waits.
8. **Termination proof today** is written when `deleteVM` returns. For GCP that is operation
   completion, or a quiet return when the lookup finds nothing (the unreachable-zone caveat,
   idea note `01M7B7H3SV4RK8H3EX4CMW92B7`, is unchanged by this task).

## Design

Two-phase provider deletion for the deadline-bounded cleanup callers, GCP first:

- Provider interface gains optional `requestVMDeletion(id, ctx, { beforeSend })` (returns
  `absent` or `requested` + opaque ticket) and `getVMDeletionStatus(ticket, ctx)` (`deleted`,
  `in_progress`, `not_requested`, `failed`, `wrong_scope`). GCP implements both: the ticket
  (project, zone, instance id, name) is handed to `beforeSend` before the DELETE, and the status
  is read from the delete operations for that exact instance id. Other providers keep the
  synchronous `deleteVM` (they already return on accept, except UpCloud).
- `deleteNodeResourcesStrict` gets `providerDeletion: 'request'`. A fresh request persists a
  write-ahead record on the node (`provider_deletion_requested_at`, `provider_deletion_json`:
  ticket + provider instance id + runtime incarnation) via the exact-incarnation CAS before the
  DELETE, then returns `deletion_pending` without proof. A later call with a matching record
  reads the status: `deleted` → termination proof (strict); `in_progress` → still pending, or
  `teardown_deletion_unconfirmed` (named, alerted, 1 h backoff) past the confirm bound;
  `not_requested`/`failed` → clear the record and fail so the guarded path runs again.
- Ownership proof (rule 56) and the incarnation fence run before every DELETE, unchanged.
  Not-found through a fallback credential is still never proof; the op record is.
- Cleanup: a new first phase `provider_deletion_confirm` owns nodes with a pending record
  (status `destroying`); the stopped/destroying handoff phases and stranded retirement exclude
  them. Handoff candidates rotate by `cleanup_backoff_until` so slow candidates cannot starve
  valid work behind them.
- Bounds: per-candidate request budget `operations.nodeProviderDeletionRequestTimeoutMs`
  (default 15 s) and unconfirmed bound `operations.nodeProviderDeletionConfirmMaxMs` (default
  30 min) as admin settings. Phase wall budget stays `NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS`
  (20 s).

## Implementation checklist

- [ ] Providers: `VmDeletionRequestResult`, `VmDeletionStatus` types; optional methods on
      `Provider`; GCP `requestVMDeletion` + `getVMDeletionStatus`; provider unit tests (ticket
      before DELETE, absent, 404, op list states incl. failed / wrong project / malformed ticket,
      abort)
- [ ] Migration `0239`: `nodes.provider_deletion_requested_at`, `nodes.provider_deletion_json`
      (ADD COLUMN only); drizzle schema
- [ ] Admin settings: request timeout + confirm max (definitions, key union, defaults in shared)
- [ ] `strict-node-deletion.ts`: request mode, pending-record match/parse (malformed → ignored +
      logged), status check across authority candidates, unconfirmed bound, clear on
      not_requested/failed and on proof write
- [ ] `node-teardown-authority.ts`: `deleteWithCurrentOwnerCredential` takes the delete action;
      new blocked reason `teardown_deletion_unconfirmed`
- [ ] `node-cleanup/shared.ts`: `pending` result, `destroy_pending` decision, confirm claim
- [ ] `node-phases.ts`: confirm phase; handoff phases exclude pending, rotate by backoff, use the
      request budget; `index.ts` phase order; result counter
- [ ] `stranded-node-retirement.ts`: exclude pending; request mode + request budget
- [ ] Decision enum `destroy_pending`
- [ ] Docs: architecture overview/security/configuration where cleanup teardown is described
- [ ] Tests (see below), each proven red on the reverted change
- [ ] Backlog: UpCloud stop-wait and unhealthy release / orphan reconciliation still bounded by
      the 5 s budget for slow providers

## Tests

- Real cron entry, provider delete longer than a tick: reaped across ticks, exactly one DELETE,
  proof only after the op reports done. Must fail on main.
- Same through the #2715 fallback path (credential row changed), including the ownership re-read.
- Never-confirming provider: bounded, named `teardown_deletion_unconfirmed`, alert, leaves the
  hot set (two sweeps).
- Full batch of slow candidates: valid work behind them is reached; tick within budget.
- Controls: Hetzner-shaped delete completes in one tick; ownership mismatch still refused.

## Acceptance criteria

- [ ] An idle managed GCP node is torn down by SAM with no owner action within ~2 cron ticks of
      first selection, with its original credential and after an in-place re-save (staging).
- [ ] Termination proof is never written because a DELETE was sent.
- [ ] Failures stay named; the unconfirmed case alerts and backs off.
- [ ] Hetzner behaviour unchanged.
- [ ] PR states per-tick wall time and worst-case time to reap at the outer limit.

## References

- `.claude/rules/81-work-bounds-must-state-throughput.md`, `apps/api/.claude/rules/47-control-loop-io-budget.md`
- `packages/providers/.claude/rules/56-destructive-provider-ownership-proof.md`
- PR #2715 (fallback credential teardown), PR #2718 (credential re-save provenance)
