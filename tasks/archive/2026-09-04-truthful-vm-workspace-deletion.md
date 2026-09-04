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
   absence needs an explicit additive proof marker. Provider deletion must additionally
   pin the encrypted credential generation used to address the external VM, because a
   credential row can rotate in place without changing its reference or timestamp.
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

- [x] Add an explicit strict node runtime-termination proof marker and migration coverage.
- [x] Add migration `0142_node_provider_credential_fingerprint.sql`; persist a SHA-256
      fingerprint of the encrypted provider credential generation, fail closed for legacy
      null proof, and re-resolve the exact credential after composable resolution so
      provider creation and the stored fingerprint use the same generation.
- [x] Centralize workspace deletion outcome classification and JIT identity validation.
- [x] Claim durable NodeLifecycle attempts before VM network I/O; refuse restart/rebuild
      cancellation after an attempt starts.
- [x] Retain deletion-unconfirmed workspaces in `stopping`, preserve durable pending state,
      and retry with configurable bounded exponential backoff and batch limits.
- [x] Require the same workspace incarnation and `stopping` status before VM-confirmed
      terminal writes.
- [x] Route explicit deletion and scheduled cleanup through the central classifier.
- [x] Emit throttled, payload-free late-callback activity evidence while preserving normal
      callback rejection and token-mint denial.
- [x] Fence linked retry/session recovery/replacement until confirmed deletion or strict
      terminal proof, with JIT TaskRunner rechecks before resource-creating work.
- [x] Preserve sleeping/restorable session semantics and ordinary idempotent cleanup.
- [x] Add exact unit and real Worker race coverage for timeout → recovery → retry,
      ownership/incarnation changes, restart/rebuild fencing, strict node proof, callback safety,
      token rejection, scheduled cleanup, replacement authority, same-row credential
      rotation, fingerprint collisions, forced A → B credential interleaving, and real-SQL
      VM request-boundary races for both restart and rebuild.
- [x] Update public configuration/security documentation and retained incident guidance.
- [x] Run full repository gates and required specialist reviews.
- [x] Deploy serially to staging; prove a real VM timeout remains quarantined and later
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
  reincarnation produces a fenced no-op. Managed provider deletion also revalidates the
  exact encrypted credential generation and fails closed on rotation or missing legacy
  fingerprint proof.
- Restart/rebuild cancellation succeeds only before any delete attempt is claimed, and both
  refuse runtime recreation when deletion wins at the final VM request boundary.
- Late callbacks create no normal side effect, ingest no callback payload, and emit only a
  bounded payload-free activity/telemetry signal.
- Linked recovery/retry remains quarantined while deletion is unconfirmed and releases
  after deletion confirmation or strict terminal proof.
- Legitimate sleep/restore and successful idle cleanup behavior remain green.
- Full local gates, mandatory reviews, CI, CodeRabbit, real-VM staging, zero-VM staging
  cleanup, merge, and production deploy verification all pass.

## Control-Loop I/O Budget

The NodeLifecycle alarm processes at most the configurable deletion batch size, claims each
due attempt durably, and dispatches its bounded VM-agent I/O through `waitUntil`. Each
attempt performs bounded D1 reads/writes and at most one VM-agent delete using the separate
background timeout. A compact due-time index lets each alarm load only the configured batch
and the next live deadline; retained dead letters never trigger a full payload scan. The
Free-plan-safe default batch is three. A bounded resumable per-DO backfill indexes durable
entries written by the pre-index release, so rollout cannot strand an existing alarm.
Unconfirmed attempts leave the immediate candidate set until their bounded exponential
`deleteAt`; both the maximum delay and maximum residence are configurable. Exhausted or
identity-changed entries remain quarantined in `stopping`, leave bounded payload-free
dead-letter telemetry, and stop consuming the immediate alarm candidate set. Only confirmed
outcomes and same-identity stale schedules for an active workspace remove the entry. Heartbeat
age and D1 status labels are never used as terminal proof.

## Validation Evidence

- Exact pushed implementation SHA `23d76eedeaa006b4f7acebc75025a0ade6472d5a` passed
  `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check:fast`, D1/DO
  migration safety and ordering, focused migration coverage, and the recovered real-Worker
  suites. Cloudflare, security, test-engineer, constitution, documentation-sync, and
  environment-sync reviews passed; the final task-completion audit found no implementation
  blocker.
- Serialized staging run `33895757952` deployed the exact SHA under the normal interactive
  timeout and passed 12/12 smoke tests. A prior serialized run (`33892683853`) was cancelled
  only after Wrangler failed to return despite Cloudflare reporting the Worker at 100% and
  the container rollout ready; the clean same-SHA retry superseded it before VM creation.
- Real workspace `01M1PN4N5881W3J5MS048YAX6H` reached `running` on provider-backed node
  `01M1PN4MNTA6DFJETZWM9X2S89`. D1 showed the node `running`/`healthy`, a fresh heartbeat,
  exact agent SHA `23d76eedeaa006b4f7acebc75025a0ade6472d5a`, and non-null runtime-incarnation
  and provider-credential-generation fences.
- Serialized fault run `33897579393` applied a `1ms` interactive and background node-agent
  timeout with a 60-second bounded retry interval at the same SHA and passed 12/12 smoke
  tests. The one authenticated DELETE returned HTTP `202` / `pending`; D1 kept the workspace
  `stopping`, both runtime-deletion proof fields null, a bounded 69-character timeout/request
  diagnostic, and the provider node `running`/`healthy`. It remained quarantined across
  multiple scheduled retry intervals.
- All four temporary variables were removed before serialized restore run `33899157453`.
  No second DELETE was issued. After the restored Worker bindings became live, the durable
  retry wrote `runtime_deletion_proof='vm_agent_confirmed'` at
  `2026-09-04T17:18:57.147Z`, changed the workspace audit row to `deleted`, cleared the
  diagnostic, and made the authenticated workspace API return not found while the node
  continued heartbeating healthy. The restore run passed 12/12 smoke tests.
- Provider-backed node cleanup returned HTTP `200`. Final D1 counts were zero nonterminal
  nodes and zero nonterminal provider nodes; the exact test-node row was gone. Direct Worker
  settings showed all four temporary variables absent, and the final authenticated live-app
  baseline passed with no browser console errors.
- The task-completion validator passed before archive. The remaining PR/CI/CodeRabbit/merge
  and production-monitoring line is completed by the sequential `/do` Phase 7 workflow.

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
including timeout, runtime recovery, ownership changes, and restart/rebuild races.
