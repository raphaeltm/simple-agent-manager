# Reliability C: complete ownership transition proposal

Status: design only; coordinator decision required. No maintenance, termination,
credential rotation, activation or production mutation is authorized by this file.
The reviewed bridge remains draft PR #2361 at `77f803d91`. A/B stays frozen at
`e2c81c045`; this proposal is on a separate design ref.

## Invariant and concrete failure

For each effective MCP identity and window, every admitted request must use one
counter owner. For each workspace, every boot-log mutation must use one ordered
owner. Rollback must preserve that owner and its consumed quota/clear fence.

Prebridge `routes/mcp/index.ts:219-227` authenticates before awaiting the body.
After an arbitrarily delayed body, lines 268-269 select
`taskId || agentSessionId || workspaceId` and enter the legacy helper. That helper
(`routes/mcp/_helpers.ts:355-374` in the prebridge tree) selects the then-current
window and writes KV directly. Promoting that identity while the request waits
therefore permits independent KV and DO counters in the same later window.
Revocation or credential expiry cannot retract authentication already completed.
Recovery retains task IDs (`services/session-recovery.ts:112-125`), so a new node
or workspace does not make an existing task a new counter identity.

The analogous boot-log problem includes a legacy KV put completing after a new
owner's clear. Corrected bridge versions serialize these operations, but cannot
retroactively change prebridge code.

## Recommended complete path: provider-assisted maintenance transition

Use the existing reviewed bridge and immutable activation protocol. Avoid a new
credential format or permanent legacy cohort. The missing primitive is a real
termination fence, not another application timer.

Before scheduling maintenance, identify a narrow supported operation that fences
prebridge executions able to mutate MCP counter keys or workspace boot-log keys,
including issuer paths that can enable those mutations. The invariant concerns
these side effects, not termination of every Worker invocation. Inventory HTTP
body waits and other producers only where an actual path can reach those keys;
WebSockets, scheduled/queue events, DOs and service bindings are not included merely
because they exist. Document the exact operation, completion acknowledgement,
residual-write semantics and failure behavior. No such operation is established;
this proposal therefore cannot execute safely. Do not repeat broad guarantee
searches, contact vendors or create infrastructure to work around that dependency.

Only after proposing that exact narrow supported operation may the coordinator
authorize the isolated experiment below. Complete it with independent review
before maintenance approval. Only after that evidence and approval can
the coordinator execute this production sequence:

1. Inventory relevant writers/issuers, their ingress and deployment/rollback artifacts.
   Pin one corrected bridge and preserve deployment/configuration manifests.
2. Enter an explicit maintenance window: stop new dispatch and mutation ingress;
   preserve supported session snapshots, staged work and local commits. Quiesce
   relevant scheduled/queue producers through supported controls. Do not force a snapshot
   while an agent is still writing. Report any session that cannot safely pause.
3. Execute the supported side-effect fence. Require its acknowledgement
   for the complete inventory. A routing change, zero observed requests or elapsed
   interval is not this acknowledgement. On incomplete coverage, abort activation.
4. Restore only corrected bridge writers, still in KV bridge mode. Verify the
   immutable activation record remains absent and all callback/issuer paths are
   the pinned corrected version. Retain existing credentials and principals.
5. Publish the existing insert-once record with a future aligned MCP window;
   read back exact contents. Run coordinator-approved runtime checks using the
   already reviewed validation procedure. Resume ingress and session work only
   after the owner/readiness assertions pass.

Current sessions experience a real interruption and reconnection/resume. Pending
requests may fail and require retry. Snapshot-unavailable work is a stop condition,
not permission to terminate it. No namespace deletion, data migration, secret
rotation or forced identity retirement is part of this plan.

Before activation, abort to the corrected KV bridge and resume service after
verifying its writers. After activation, rollback only to corrected versions
that consult the same immutable record and retain the DO bindings/protocol.
Never reset the record, quota or clear fence, and never return to prebridge code.

The precise human action, **after the primitive and impact inventory are proven**,
is approval of a bounded production maintenance window that interrupts the
enumerated active sessions/requests using that exact termination operation.
Ordinary internal owner checks, compatibility plumbing, tests and documentation
do not themselves need a new authorization. Do not ask for a blanket auth waiver
or approval of an unproven cancellation procedure.

## Why ordinary alternatives do not yet replace that step

- A shared owner record fixes corrected writers; old binaries never read it.
- A new token prefix/audience rejects old validators, but does not cancel prior
  authentication or stop an old issuer from minting a legacy-compatible token.
- New unpredictable workspace **and node** births can fence the known old
  node-ready query (`routes/node-lifecycle.ts:164,180,214-241`). This is a possible
  partial rollout only. All old TaskRunner state-assignment paths still need proof
  that they cannot acquire those identities; bootstrap mints from persisted input
  (`task-runner/agent-session-step.ts:107-108`,
  `agent-session-bootstrap.ts:292,314-333`). Existing identities remain KV-owned
  indefinitely, so this does not complete the requested hot-KV removal.
- A storage-side fence would also be sufficient **if enforced against old direct
  KV writes**. A new DO check is not such a fence. No supported per-key write
  revocation primitive has been established. Deleting/replacing the shared KV
  namespace would affect unrelated credentials/state and is excluded from this
  proposal, rather than disguised as a narrow C fix.

## Evidence required before implementation or activation

Keep the existing held-body, held-KV-put/clear, immutable-record and mixed-version
regressions. Do not run a new experiment until the exact narrow supported fencing
operation is proposed and the coordinator authorizes its validation. Then use an
isolated experiment that holds an authenticated old
request and a deferred write across the proposed termination operation, proves
both cannot mutate afterward, and verifies corrected-only restart/rollback.
The experiment supplements the provider guarantee; a successful sample alone
does not prove all old invocations terminated. Stage it only under coordinator
ownership using actually separate stores, with resource and cleanup evidence.

No further ordinary code implementation is identified until that primitive is
proven. This is a concrete operational dependency, not a request to weaken an
authorization gate or accept permanent legacy ownership.

## Primary-source limits

[Workers duration limits](https://developers.cloudflare.com/workers/platform/limits/#duration)
do not impose a connected-HTTP wall deadline. The
[Delete Worker API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/)
documents script deletion and warns that forced deletion can break service
bindings; it does **not** document acknowledgement that all existing executions
and deferred storage operations have terminated. Therefore script deletion is
not currently an approved implementation of step 3.
