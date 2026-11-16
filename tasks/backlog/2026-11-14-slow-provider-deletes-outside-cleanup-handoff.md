# Slow provider deletes outside the cleanup handoff phases

## Problem

PR for task `01M7C4ZYY7E0QGCX8KCD46JGGD` (idea `01M7C4MS211R0Y73CWPHK47B9K`) made the cleanup
cron's stopped/destroying handoff phases and stranded-node retirement start a provider deletion
without waiting for it (two-phase, `services/node-provider-deletion.ts`). Three other deadline-
bounded callers still give a candidate `NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS` (5 s) for a
synchronous `deleteVM`, and two providers' `deleteVM` wait for completion:

- `scheduled/node-cleanup/unhealthy-nodes.ts` (unhealthy release): a GCP node that loses heartbeat
  still gets 5 s for lookup + DELETE + operation poll. Two-phase was not applied because the
  release terminalizes stranded tasks only on `destroyed`; a `pending` outcome needs that step
  moved to the confirm phase first.
- `scheduled/provider-orphan-reconciliation-core.ts`: deletes orphan VMs through `deleteVM` under a
  5 s `AbortSignal.timeout`. No proof is written there, so an aborted poll after a sent DELETE is
  harmless, but a GCP lookup that does not reach the DELETE in 5 s retries every pass.
- `services/deployment-node-cleanup.ts` / `scheduled/deployment-node-cleanup.ts`: deployment nodes
  on GCP have the same 5 s shape.
- UpCloud `deleteVM` soft-stops and waits for `stopped` before deleting
  (`packages/providers/src/upcloud.ts`); it has no two-phase implementation.

## Acceptance Criteria

- [ ] Each caller above either uses two-phase deletion with a confirm step, or states why its
      budget fits the slowest provider (rule 81 arithmetic in the PR)
- [ ] UpCloud implements `requestVMDeletion` / `getVMDeletionStatus`, or its stop wait is shown to
      fit the cron budget
- [ ] Cron-entry tests per caller with a provider whose delete outlasts one attempt
