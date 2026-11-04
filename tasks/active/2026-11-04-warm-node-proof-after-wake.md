# Warm node destroyed late: a wake released the slept workspace's binding

## Problem

Warm node `01M6F4WPF51FYE55F3FVHJ6YAZ` was destroyed about 35 minutes late (production, 2026-11-04).
The stopped-node handoff kept skipping it with `unproven_workspace_deletion` and
`unproven_snapshot_source`. Only bounded stranded retirement destroyed it. Requested by Raphaël via
orchestrator task `01M6GGJJAYQBEZXX2E93C9Y4WW`, as Part 3 of SAM task `01M6KCDGN1Q04CZPMWDT81SME3`.
Constraint: do not relax the proof requirement (rule 56).

## Research Findings

- Production D1: none of the node's 41 workspaces had a per-workspace deletion proof until
  `markWorkspaceRuntimeTerminationConfirmed` stamped `node_runtime_terminated` on all of them at
  13:00:40.
- Platform error `457b5868-…` named the unpreserved sources. Two of them
  (`01M6GN79XEPMQ66532QKHXKEX2`, `01M6GN7Y2872QN9JFYTBBJ2GZH`) were slept workspaces:
  - Their snapshots were available, sleeping and `recovery_status='waking'`.
  - Their recovery tasks had been stuck queued (node_selection) since Nov 3 14:08.
  - `workspaces.chat_session_id` was NULL.
- `createRecoveryTask` (`session-recovery.ts`) releases the old workspace's chat binding in the
  same transaction that claims the snapshot.
- Both preservation checks matched the snapshot by the workspace's *current* binding, so a released
  binding meant "unpreserved":
  - `automaticDeletionPreservationExpiresAt` returned early on a null `chatSessionId`.
  - `preservedVmSourceSql` and `workspaceArtifactsRetirementGuardSql` used
    `saved.chat_session_id IS w.chat_session_id`.
- Consequence:
  - The deletion queue refused or deferred the workspace forever.
  - The wake fence (`assertReplacementDeletionConfirmed`) waited on that deletion.
  - The handoff refused the node, a deadlock that only the stranded-node deadline broke.
- The third source (`01M6FQYXTMG8FDSW29JY6FZ208`) was a failed transcript-only fallback with an
  expired snapshot. Stranded retirement is the designed path for it; it is out of scope here.
- 9 production snapshots are stuck `waking` with no recovery workspace for more than 2 hours. This
  fix lets their old workspaces be deleted with proof, which releases the fence. Whether their
  queued tasks then place is tracked on idea `01M6K6R2255R7414WSER4N3STJ`.
- Not changed, because they are not on the proof path, and no follow-up is needed (no observed
  defect):
  - `preservedVmRetirementActivitySql` falls back to the workspace's own clock for an unbound row.
  - `retired-vm-sleep-repair.ts` skips a legacy repair for an unbound row.

## Implementation Checklist

- [x] `findPreservationSnapshot`: an unbound workspace matches its snapshot only while the snapshot
      holds a wake claim: `recovery_task_id` set and `recovery_status` in
      `WAKE_CLAIM_RECOVERY_STATUSES` (waking, failed, restored; the same set as `claimStillOwned`).
      `recovery_task_id` alone is never cleared, and a completed sleep resets the status. If more
      than one snapshot matches, the workspace stays unpreserved (fail closed).
- [x] `snapshotConversationMatchesSql`, the same rule in SQL, used by `preservedVmSourceSql` and
      `workspaceArtifactsRetirementGuardSql`.
- [x] Review fix (security-auditor MEDIUM, validator HIGH): the claim was `recovery_task_id` only, a
      write-once proxy (rule 74). Tightened in both TS and SQL, with stale-claim and ambiguous-row
      controls.
- [x] Workers test, real NodeLifecycle DO. A slept workspace under a wake:
  - is scheduled for deletion;
  - is deleted with `vm_agent_confirmed`;
  - releases the wake fence.
  The controls: an unbound workspace with no wake claim, or only a stale wake task, is refused at
  enqueue. Only this test can observe the TS status conjunct, since the SQL guard masks it in the
  handoff tests.
- [x] Unit test, real SQL: the stopped-node handoff retires the node on the first pass. The
      controls: no wake claim; a stale wake task; two claimed snapshots; the wake task or the held
      status disappears between preparation and the atomic claim.
- [x] Pre-fix red and post-fix green recorded. Each guard was deleted once, and exactly its
      test went red:
  - TS status conjunct: the workers stale-claim control;
  - TS ambiguity check: the two-snapshot control;
  - SQL task-id conjunct: the race test "loses its wake task";
  - SQL status conjunct: the race test "loses its held claim state".
- [x] Architecture overview updated.

## Acceptance Criteria

- [x] A slept workspace whose wake released its binding gets deletion proof on its first due attempt.
- [x] Its stopped node is destroyed on the first cleanup pass.
- [x] No unbound workspace without a held wake claim is treated as preserved, including one with only a stale wake task.
