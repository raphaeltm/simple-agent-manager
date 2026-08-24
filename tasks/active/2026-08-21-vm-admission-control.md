# VM admission control and node-packing backpressure

## Context

Production saw Hetzner account server-limit failures while concurrent VM cold starts were allowed to race. Multiple task/session submissions can decide no reusable node exists and then independently provision fresh nodes before any new node becomes reusable. Raphaël marked this as absolutely crucial.

This task is implementation follow-through for:

- Idea `01M0FV9VBP8ZATBG2E63R8GD0M`
- Research task `01M0G26W1P86CBCG3G4YQYNBMB`

The architecture research is complete. Do not re-run it or revive stale PR #1808.

## Branch / workflow notes

- SAM assigned output branch: `sam/implement-vm-tasksession-admission-w2zmx6`
- Starting base: `35e74d8373891a75900d0667dcf9baa3f4003f68`, matching `origin/main` at start.
- Deviation from normal worktree setup: the current workspace was already on the SAM-provided output branch, so implementation proceeds in-place rather than creating another nested worktree.
- Staging mutation/deploy and merge are explicitly forbidden until the parent grants the single staging slot.

## Research findings to implement

- TaskRunner’s VM path has a race between node selection and provisioning. `node_selection` can send many tasks to `node_provisioning`; `node_provisioning` creates nodes independently.
- Existing placement invariants must remain authoritative:
  - same-user node isolation
  - VM size compatibility through `canSatisfyVmSize`
  - agent health/readiness/version checks
  - final atomic `reserveWorkspacePlacement()` slot reservation
- Admission state must be durable and visible in D1, with inspectable reasons and retry times.
- A fenced provisioning lease/claim must be concurrency-safe and expire/recover safely. Stale owners must not be able to mutate provider state after losing the lease.
- Winners must re-run node selection after acquiring the provisioning claim so a task can pack onto a node that became reusable while it waited.
- Waiters need bounded retry/alarm wakeups and explicit cancellation/terminal cleanup escape paths.
- Hetzner `server_limit_exceeded` must be classified as provider/account capacity and queued/backpressured, not as a terminal task/provider-auth failure or VM size fallback.
- Ordinary VM task/conversation submit, MCP dispatch, trigger submit, and mission dispatch all start TaskRunner DOs. Central TaskRunner admission should cover the first three; mission scheduling must avoid repeatedly dispatching queued admission waiters.
- Node-ready, cleanup, terminal task cleanup, stuck-task reconciliation, and admin diagnostics need admission integration so waiters are woken and stale waits can be inspected or expired.
- Control loops must be bounded and configurable.

## Implementation checklist

- [x] Add additive D1 migration and Drizzle schema for VM admission records, provisioning leases, provider capacity state, and task admission mirror fields.
- [x] Add shared task execution step `waiting_for_node_capacity` and task response fields for admission state/reason/next retry.
- [x] Add configurable admission control env vars with defaults and docs.
- [x] Implement VM admission service:
  - [x] durable admission upsert and task mirror updates
  - [x] per-scope fenced provisioning lease acquire/renew/release/assert
  - [x] requeue/wait state with bounded retry and deadline
  - [x] provider/account capacity state and Hetzner server-limit classification
  - [x] bounded wakeup of waiting TaskRunner DOs
  - [x] cancellation/terminal cleanup helpers
- [x] Wire TaskRunner:
  - [x] wait/retry before provisioning when another compatible claim is active
  - [x] re-select existing node after acquiring claim
  - [x] fence provider mutations before and during provisioning
  - [x] hold/renew lease until the provisioned node is reusable or placement completes
  - [x] release/cancel admission on success, failure, cancellation, and cleanup
- [x] Wire node-ready and task cleanup paths to wake or cancel admissions.
- [x] Update mission dispatch scheduling so queued admission waiters are not re-dispatched or ignored by active-count gates.
- [x] Update stuck-task reconciliation/diagnostics so legitimate admission waits are preserved until deadline and expired waits fail visibly.
- [x] Add bounded admin diagnostics/listing for admission state and placement reasons.
- [x] Add deterministic concurrency/race tests proving:
  - [x] simultaneous cold starts produce one active provisioning claim and waiters, not a stampede
  - [x] lease expiry/recovery is fenced and stale tokens cannot mutate/release new ownership
  - [x] Hetzner server-limit errors record provider/account capacity and queue retry
  - [x] existing-node packing remains correct, including same-user isolation and VM-size compatibility
  - [x] mission dispatch does not duplicate queued admission waiters
- [x] Run focused local tests and typecheck.
- [x] Run specialist reviews: constitution-validator, test-engineer, cloudflare-specialist, security-auditor, doc-sync-validator, env-validator; go-specialist only if Go changes.
- [x] Commit and push incremental progress before long tests.
- [x] Open draft PR #1876 and let CI run.

## Acceptance criteria

- Simultaneous cold-start submissions for the same user/provider scope cannot provision more than one fresh node before a reusable node exists.
- Waiters are visible with `waiting_for_node_capacity`, an admission reason, and a bounded next retry/deadline.
- After the provisioning claim is acquired, the winner rechecks existing nodes before creating a new node.
- Existing node packing still honors same-user isolation, VM-size compatibility, node health/readiness/version checks, project scaling limits, and `reserveWorkspacePlacement()` CAS.
- Hetzner provider account server limits queue/backpressure with provider/account-capacity reason; they are not treated as terminal auth/config failures or silent size fallback.
- Cancelling/archiving/failing a task releases or terminalizes its admission and lease state even before a workspace exists.
- Mission dispatch does not create duplicate runner/session starts for queued admission waiters.
- Admin/reconciliation diagnostics expose current admission state, lease/capacity reason, retry time, deadline, and relevant provider error classification.
- Staging remains untouched; final handoff includes a staging plan using at most 1-2 staging VMs and cleanup back to zero.
