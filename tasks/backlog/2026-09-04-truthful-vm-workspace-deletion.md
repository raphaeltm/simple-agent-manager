# Truthful, retryable VM workspace deletion

**SAM task**: `01M1MTHWA6RQNNREPGVF8QXAJ4`
**Output branch**: `sam/execute-implementation-using-skill-8qxaj4`
**Status**: backlog

## Problem

VM workspace deletion currently treats an HTTP timeout or error as proof that the runtime was
deleted. `NodeLifecycle` catches `deleteWorkspaceOnNode()` failures, writes
`workspaces.status='deleted'`, finalizes the linked agent/session lifecycle, removes the durable
pending-deletion entry, and emits `workspace_auto_deleted`. The scheduled safety-net sweep and
explicit workspace cleanup use the same unsafe best-effort pattern.

Production demonstrated the resulting split brain. After tasks
`01M1MJN41VG0Y964CTQ6S06Q4D` and `01M1M75WA3V528VYZCWQGGM3NT` were falsely terminalized,
NodeLifecycle attempted VM DELETE at 22:21 UTC. Both requests timed out after 30 seconds, but D1
and ProjectData were finalized anyway. The same runtimes recovered at 22:44 and emitted 120 and 56
terminal-workspace callbacks. One old runtime then advanced PR #2010 after its replacement had
started. A timeout therefore created two runtimes with plausible authority over the same work.

PR #2010 and PR #2011 are takeover-owned release work and are strictly out of scope. PR #2011 was
inspected read-only: it changes interrupt/cancel handling and does not own the workspace deletion,
callback quarantine, or replacement-authority contracts in this task.

## Research findings

### Deletion writers

- `apps/api/src/durable-objects/node-lifecycle.ts`
  - The pending deletion is already durable DO state, but contains only node/workspace/user and one
    fixed deadline.
  - `deleteWorkspace()` catches the VM-agent error and still marks `stopped`/`sleeping` rows
    `deleted` and invokes `finalizeWorkspaceLifecycleClosure()`.
  - `processExpiredDeletions()` consequently removes the durable entry and logs success.
- `apps/api/src/scheduled/node-cleanup/workspace-phases.ts`
  - The stale-stopped safety net catches VM-agent DELETE failure and still marks the row deleted.
- `apps/api/src/services/workspace-cleanup.ts`
  - Explicit workspace deletion and conversation/task-close cleanup catch runtime cleanup failure,
    then finalize and hard-delete the D1 workspace row.
- TaskRunner success/failure and sleep cleanup schedule NodeLifecycle deletion. They are indirect
  writers and must inherit the central proof classifier without changing legitimate stop/sleep
  semantics.
- The VM agent's `DELETE /workspaces/:id` handler is idempotent and returns 2xx after container,
  volume, reporter, scanner, and runtime state removal. A 2xx response is usable deletion/absence
  proof; a transport error, timeout, or ambiguous response is not.
- An owning node that is authoritatively absent or `deleted` is terminal proof. `stopped`, health,
  and heartbeat age are not terminal proof.

### Available durable state

- `WorkspaceStatus` already includes `stopping`; callbacks already reject every status except
  `creating`, `running`, and `recovery`.
- `workspaces.error_message` can carry a bounded user/operator diagnostic. Attempt counters,
  first-attempt time, last-attempt time, and next-attempt time fit in the existing NodeLifecycle
  pending entry, so workspace deletion itself needs no D1 migration.
- A pending entry must capture the expected node, user, project, and chat-session assignment. Every
  attempt must re-read those values immediately before the VM request and compare them again before
  terminal D1/finalizer writes. Reassignment or restart is a no-op, not authority to delete a new
  incarnation.
- Retry and recovery TaskRunners need a durable predecessor edge after their request handler exits.
  Session recovery already has `recovery_source_task_id`; general retry paths do not. An additive
  nullable `retry_source_task_id` task column is therefore required to make the retry fence durable
  and re-checkable at every TaskRunner external-mutation boundary.

### Callback and replacement surfaces

- Shared callback guards already return terminal responses for `stopping`, `stopped`, and
  `deleted`, which blocks normal task/git/token/publish side effects.
- `POST /workspaces/:id/messages` authenticates first but parses and validates the message payload
  before loading the workspace. It must load/fence the workspace before parsing so late prompt/tool
  payloads are never ingested.
- Rejected callbacks currently produce logs but no bounded activity signal. Deletion-unconfirmed
  callbacks need a throttled ProjectData activity event containing only controlled identifiers,
  callback kind, workspace status, and node status—never request bodies, prompt/tool data, tokens,
  errors copied from the VM, or secrets.
- `ensureSessionRecovery()`, the legacy MCP `retry_subtask`, and the SAM-session `retry_subtask` can
  allocate a replacement without checking whether their predecessor workspace is `stopping`.
  TaskRunner already revalidates recovery authority at external boundaries; the same durable
  authority check must include deletion quarantine and the new retry lineage.
- GitHub App installation tokens already issued to an old runtime cannot be individually revoked by
  SAM. The control plane can and must reject fresh token minting and all callback side effects while
  `stopping`, but an issued token can remain usable until its GitHub expiry. Documentation and PR
  risk notes must state this honestly; this task does not introduce a new credential system.

### Lifecycle symmetry and control-loop load review

- `finalizeWorkspaceLifecycleClosure()` is the canonical idempotent lifecycle writer and preserves
  a live/restorable sleeping snapshot. It must run only after deletion proof, not on ambiguous
  attempts.
- Successful VM DELETE, idempotent absence, and terminal-node proof converge through the same
  finalizer. Timeout/error/unknown outcomes stay `stopping`, keep the durable entry, and retry.
- Retry delay is exponential and bounded by configurable base/max values. Attempt diagnostics are
  length-bounded and the pending entry is retained indefinitely for safety; after a configurable
  age/attempt threshold, bounded telemetry identifies operator attention without converting age to
  deletion proof.
- Expected steady-state due entries are low (normally zero to a handful per node). Each alarm pass
  performs bounded D1 identity reads and at most one VM DELETE per due entry. Backoff caps repeated
  work, the scheduled sweep is already batch-limited, and callback activity emission is throttled
  per workspace/callback kind.

## Implementation checklist

- [ ] Add a central workspace-deletion service with explicit `confirmed`, `retry`, and `fenced`
      outcomes. Only VM 2xx/idempotent absence or authoritative terminal node state may confirm.
- [ ] Transition eligible workspaces to `stopping` before external deletion, store bounded
      diagnostics in `error_message`, and use expected-assignment guards before and after the call.
- [ ] Extend NodeLifecycle pending entries with expected project/session assignment and bounded
      attempt metadata; retain them on every ambiguous/fenced outcome and use configurable capped
      exponential backoff.
- [ ] Keep alarms live after failures, emit bounded escalation telemetry, and never use heartbeat
      age or retry age as terminal proof.
- [ ] Route NodeLifecycle, stale-stopped scheduled cleanup, explicit workspace delete, conversation
      close, and indirect TaskRunner cleanup through the same outcome classifier.
- [ ] Make explicit deletion truthful to callers: confirmed deletion may remove the historical row;
      ambiguous deletion returns a pending/quarantined result and leaves the row/finalizer intact.
- [ ] Add a payload-free, throttled deletion-unconfirmed callback activity/telemetry helper and wire
      shared workspace, project publish, task, ACP activity, heartbeat, and message callback guards
      as appropriate.
- [ ] Load and reject inactive message workspaces before reading the request body.
- [ ] Add nullable `tasks.retry_source_task_id`, its index, schema/shared response plumbing if
      exposed, and set it atomically in both retry-subtask implementations.
- [ ] Add one shared predecessor-deletion fence used by session recovery, both retry handlers, and
      TaskRunner's repeated external-mutation authority checks. `stopping` waits/quarantines;
      confirmed `deleted`/absent or terminal node proof releases the fence.
- [ ] Preserve existing sleep snapshot/finalizer behavior and successful idempotent cleanup.
- [ ] Document retry/backoff/telemetry configuration and the GitHub installation-token revocation
      limitation.
- [ ] Add the mandatory postmortem and durable process-rule update for this production bug.

## Required regression tests

- [ ] Incident race: VM DELETE times out, workspace remains `stopping`, pending deletion/finalizers
      remain live, late runtime callback is rejected with one bounded activity signal, then retry 2xx
      confirms and finalizes exactly once.
- [ ] Timeout followed by runtime recovery cannot mutate task/git/session state or obtain a fresh Git
      token; prompt/tool request bodies are not parsed/persisted.
- [ ] Repeated timeout/error uses increasing capped retry deadlines and never consumes/removes the
      durable entry merely because it is old.
- [ ] VM 2xx/idempotent absence confirms deletion and removes the pending entry.
- [ ] Owning node authoritatively destroyed/deleted confirms deletion without a VM request.
- [ ] `stopped`, unhealthy, stale heartbeat, or old heartbeat does not prove deletion.
- [ ] Workspace node/user/project/session reassignment between schedule, attempt, and confirmation is
      a no-op for the new incarnation and does not finalize it.
- [ ] Scheduled safety-net and explicit/task cleanup return the same outcome classification as
      NodeLifecycle.
- [ ] Linked session recovery, legacy MCP retry, and SAM-session retry are held while predecessor
      deletion is unconfirmed and released after confirmation/terminal proof.
- [ ] A replacement TaskRunner that loses the race after creation re-checks before node/workspace,
      repository, agent-session, and credential side effects.
- [ ] Existing stopped-workspace successful cleanup remains green.
- [ ] Sleeping/restorable snapshot cleanup remains green and the snapshot stays wakeable.
- [ ] Existing callback terminal/tombstone behavior remains quiet and idempotent.
- [ ] Mutation/discrimination check: restoring the old catch-and-finalize behavior makes the incident
      test red while success and terminal-proof controls remain green.

## Acceptance criteria

- A VM-agent timeout/error is never represented as completed deletion and never triggers lifecycle
  finalization or removal of the durable pending deletion.
- Deletion in progress is visible as `stopping` with bounded diagnostic/attempt context and retries on
  configurable bounded backoff.
- Every retry re-reads the current workspace assignment just in time and cannot delete/finalize a
  reassigned or restarted workspace.
- Late callbacks from a quarantined runtime produce no normal side effect and emit bounded,
  payload-free evidence that deletion remains unconfirmed.
- Linked recovery/retry/takeover cannot allocate or operate a replacement while its predecessor is
  quarantined; it proceeds after deletion confirmation or authoritative terminal-node proof.
- Heartbeat age never supplies terminal proof and no retry counter/age silently converts ambiguity
  into success.
- Successful cleanup and sleep/restorable-session behavior remain unchanged and idempotent.
- Focused tests, full `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- Specialist review, staging real-VM failure/convergence verification, CI, CodeRabbit, merge, and
  production verification complete under the `/do` workflow.

## Postmortem and process fix

The original implementation conflated request completion with effect completion: it caught the only
evidence-bearing operation, then wrote the success state unconditionally. Tests asserted retry only
around thrown wrapper errors and did not order “timeout → runtime recovers → callback/remote write →
retry”. Because replacement paths did not consume the deletion writer's ambiguous state, a false
terminal marker silently became replacement authority.

The durable process fix is to extend the lifecycle-writer rules with a proof-bearing destructive
operation requirement: every destructive external cleanup must expose a shared outcome classifier;
unknown outcomes must remain durable and fenced; every linked resumer/retrier must consume that
state at its final external boundary; and regression tests must control the ordering through the real
writer, late callback, and replacement trigger.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/45-durable-object-reentrancy.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/49-capture-prerequisites-before-async-work.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/61-runtime-profile-gates-must-cover-every-runtime.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/66-ownership-handoff-supersession.md`
- `apps/api/src/durable-objects/node-lifecycle.ts`
- `apps/api/src/services/workspace-cleanup.ts`
- `apps/api/src/services/session-recovery.ts`
- `apps/api/src/routes/projects/_callback-auth.ts`
- PR #2011 (read-only overlap check)
