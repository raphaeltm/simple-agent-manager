# A task cancelled by its parent is resurrected by a wake claim

## Problem

Production task `01M7JC1MTRFT8PWRQ8BNFP8D6W` (chat `a4c110be-dcf9-4d11-8472-fef6f1414cf5`) was
cancelled by its parent at 2026-11-16T20:36:26Z ("Stopped by parent"). Ten seconds later a wake claim
moved it `cancelled -> queued` ("Sleeping conversation wake claimed"), followed by two more claims in
25 seconds. A cancelled task should not be woken back into the queue.

## Context

Found during task `01M7MZJJWKJYV88BSMQEGJPBXB` (provider-limit holds) while verifying how the chat
spent its wake budget. Adjacent to idea `01M7K6XPFHT4G7HPCGZBB1Z9ZK` (a parent cannot stop a parked
child): even a successful stop can be undone by a queued delivery's wake.

## Acceptance Criteria

- [ ] Identify which claim path reactivates a `cancelled` task (`claimSessionSnapshotRecovery` /
      stable-task reactivation in `session-recovery.ts`).
- [ ] A cancelled task is never reactivated by a wake; its queued deliveries end with a clear,
      non-error outcome.
- [ ] Regression test: cancel through the real stop path, then run the real delivery wake; the task
      stays cancelled.
