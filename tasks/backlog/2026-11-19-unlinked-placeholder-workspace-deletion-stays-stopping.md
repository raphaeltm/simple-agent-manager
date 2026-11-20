# An Unlinked Placeholder Workspace Cannot Be Deleted After Its Attach Kept Failing

## Problem

On primary staging, workspace `01M7RMD7HA25QMYFMACB8Q2788` was created through
`POST /api/workspaces` without a `nodeId`. Its node `01M7RMD7ADHMD443V4QAEQ7S1N` booted, but the
placeholder attach (`attachPrecreatedWorkspacePlacement`) failed on every NodeLifecycle alarm, so
the workspace never received a `node_id`. That attach failure was the D1 expression-depth error
fixed in PR #2853.

After the test harness deleted the workspace and then the node:

- `DELETE /api/workspaces/:id` returns 202 `{ deletionStatus: "pending", reason: "runtime_deletion_unconfirmed" }`.
- The row stays `stopping` with `error_message` "Runtime deletion unconfirmed after attempt 1 (node
  assignment unavailable)" (`workspace-deletion.ts:requestWorkspaceDeletion`).
- The node row is gone and no provider instance was ever recorded on the workspace, so nothing
  bills, but nothing retires the row either.

Unassigned deletion asks the `workspace-create:<workspaceId>` NodeLifecycle DO
(`confirmUnassignedWorkspaceDeletion`), which is the same key `scheduleDirectProvisioning` uses.
Why it refused here is unverified. A likely candidate is that the DO's provisioning attempt was
still retrying the failed attach when deletion was requested.

Four older staging rows show the same shape (`stopping`, `node_id` NULL): `01M2CX7BFQ64E1KY2E91148Y5C`,
`01M6J4ZSW767BF322X7Y0NDAJG` (tracked separately in
`2026-11-04-providerless-node-allocation-unresolved-never-retires.md`), `01M73GH6JMCM9TZGNKMT4J2K4J`,
`01M73GRE2TCGNZZWAGK9BM4EGG`.

## Context

Found 2026-11-19 during PR #2853 staging verification (task `01M7PX4F5CPXBW4TEZCHCRAGC6`).

## Acceptance Criteria

- [ ] Determine from the NodeLifecycle DO state why `confirmUnassignedWorkspaceDeletion` refused
      for a placeholder whose provisioning attempt was failing and whose node was later deleted.
- [ ] A never-attached workspace whose provisioning work is terminal, cancelled or whose node is
      gone reaches `deleted` without operator action, with a test through the real deletion entry point.
- [ ] Every fence that keeps such a row in `stopping` has a time bound and an escalation path.
- [ ] Existing stuck staging rows are resolved by the fixed path, not by hand-editing D1.
