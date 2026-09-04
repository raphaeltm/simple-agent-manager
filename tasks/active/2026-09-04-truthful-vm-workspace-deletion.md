# Truthful, retryable VM workspace deletion

## Problem Statement

SAM currently treats a failed or timed-out VM-agent `DELETE /workspaces/:id` request as
proof that the runtime is gone. `NodeLifecycle` then writes `workspaces.status='deleted'`,
finalizes the linked session, removes the durable deletion entry, and may let recovery or
replacement work start while the old runtime can still resume. Production observed this
exact split-brain window after two 30-second delete timeouts and later callbacks from the
supposedly deleted runtimes.

This task was recovered from failed task `01M1MTHWA6RQNNREPGVF8QXAJ4`. Its agent was
falsely terminalized for `node_stale_heartbeat` while full typecheck was running; the
implementation workspace was subsequently deleted without a captured WIP artifact. The
available transcript and focused green evidence are the recovery source.

## Research Findings

1. `NodeLifecycle.processExpiredDeletions()` catches VM delete failures and the old
   `deleteWorkspace()` still marks D1 deleted and finalizes lifecycle. A request timeout
   proves only uncertainty.
2. Explicit deletion and the scheduled safety net duplicate the same unsafe
   classification, so outcome semantics must be centralized.
3. A D1 node `status='deleted'` label is not strict proof: legacy provider teardown paths
   can write it after provider deletion failure. Strict provider/container success or
   absence needs an explicit additive proof marker.
4. Pending deletion entries are durable but lack identity/incarnation data, attempt
   claims, and bounded retry metadata. Restart can currently cancel an attempt after the
   network call has begun.
5. Callback routes already reject many terminal workspace states, but stopping/deletion-
   unconfirmed callbacks need payload-free, bounded telemetry without permitting normal
   message/task/git/control-plane effects.
6. Recovery and retry entry points carry predecessor task lineage. They must fence linked
   replacement authority while the predecessor workspace remains deletion-unconfirmed,
   and TaskRunner must revalidate that authority immediately before resource-creating
   steps.
7. Rule 47 requires a short configurable background timeout, bounded batch and backoff,
   and a durable escape path. Rule 53 requires precondition deferrals to remain selectable
   without spending destructive retry budget. Rules 44/49 require enumerating writers and
   performing JIT compare-and-set validation after network calls.
8. The 2026-08-07 provisioning cleanup race postmortem confirms destructive lifecycle
   loops must protect ownership held by another state machine and include real interleaving
   tests; local assumptions are insufficient across async boundaries.
9. PR #2011 is a separate interrupt-reliability change. It was inspected read-only and is
   outside this task; PRs #2010 and #2011 must not be modified.

## Implementation Checklist

- [ ] Add an explicit strict node runtime-termination proof marker and migration coverage.
- [ ] Centralize workspace deletion outcome classification and JIT identity validation.
- [ ] Claim durable NodeLifecycle attempts before VM network I/O; refuse restart
      cancellation after an attempt starts.
- [ ] Retain deletion-unconfirmed workspaces in `stopping`, preserve durable pending state,
      and retry with configurable bounded exponential backoff and batch limits.
- [ ] Require the same workspace incarnation and `stopping` status before VM-confirmed
      terminal writes.
- [ ] Route explicit deletion and scheduled cleanup through the central classifier.
- [ ] Emit throttled, payload-free late-callback activity evidence while preserving normal
      callback rejection and token-mint denial.
- [ ] Fence linked retry/session recovery/replacement until confirmed deletion or strict
      terminal proof, with JIT TaskRunner rechecks before resource-creating work.
- [ ] Preserve sleeping/restorable session semantics and ordinary idempotent cleanup.
- [ ] Add exact unit and real Worker race coverage for timeout → recovery → retry,
      ownership/incarnation changes, restart fencing, strict node proof, callback safety,
      token rejection, scheduled cleanup, and replacement authority.
- [ ] Update public configuration/security documentation and retained incident guidance.
- [ ] Run full repository gates and required specialist reviews.
- [ ] Deploy serially to staging; prove a real VM timeout remains quarantined and later
      converges; return staging to zero VMs.
- [ ] Open exactly one PR, complete CI and iterative CodeRabbit review, merge, and monitor
      production deployment and deletion telemetry.

## Acceptance Criteria

- A VM delete timeout/error leaves the exact workspace non-deleted in `stopping`, does not
  finalize its lifecycle, and retains a bounded durable retry.
- A later retry against the recovered node converges exactly once after VM-confirmed
  success or idempotent absence.
- Strictly confirmed provider/container termination permits finalization without a
  reachable VM; a D1 node status label alone never does.
- Every attempt re-reads workspace/node/user/project/session identity, and reassignment or
  reincarnation produces a fenced no-op.
- Restart cancellation succeeds only before any delete attempt is claimed.
- Late callbacks create no normal side effect, ingest no callback payload, and emit only a
  bounded payload-free activity/telemetry signal.
- Linked recovery/retry remains quarantined while deletion is unconfirmed and releases
  after deletion confirmation or strict terminal proof.
- Legitimate sleep/restore and successful idle cleanup behavior remain green.
- Full local gates, mandatory reviews, CI, CodeRabbit, real-VM staging, zero-VM staging
  cleanup, merge, and production deploy verification all pass.

## Control-Loop I/O Budget

The NodeLifecycle alarm processes at most the configurable deletion batch size. Each due
entry performs bounded D1 reads/writes and at most one VM-agent delete using the separate
background timeout. Unconfirmed attempts leave the immediate candidate set until their
bounded exponential `deleteAt`; the maximum delay is configurable. Identity changes and
confirmed outcomes remove the entry. Heartbeat age and D1 status labels are never used as
terminal proof.

## References

- `apps/api/src/durable-objects/node-lifecycle.ts`
- `apps/api/src/services/workspace-cleanup.ts`
- `apps/api/src/services/workspace-lifecycle-finalizer.ts`
- `apps/api/src/services/session-recovery.ts`
- `apps/api/src/routes/projects/_callback-auth.ts`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/49-capture-prerequisites-before-async-completion.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `tasks/archive/2026-08-07-fix-provisioning-node-cleanup-race.md`
- Read-only overlap reference: https://github.com/raphaeltm/simple-agent-manager/pull/2011

## Post-Mortem

### What broke

After VM-agent delete calls timed out, SAM declared workspaces deleted and released linked
replacement authority. The original runtimes later resumed and sent callbacks, opening a
window where old and replacement owners could both write.

### Root cause

Deletion request completion and deletion proof were conflated. Multiple paths duplicated
that classification, D1 node status was treated as stronger evidence than it is, and the
durable alarm entry did not record a pre-network attempt claim or full workspace identity.

### Process fix

All workspace deletion callers use one proof-bearing classifier. Destructive completion
requires VM-confirmed success/absence or an explicit marker written only after strict
provider/container termination. Regression tests must cause the real async interleavings,
including timeout, runtime recovery, ownership changes, and restart races.
