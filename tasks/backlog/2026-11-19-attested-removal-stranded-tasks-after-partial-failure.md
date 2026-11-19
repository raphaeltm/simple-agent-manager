# Attested node removal can leave active tasks non-terminal after a partial failure

## Problem

Found by CodeRabbit on PR #2900 (comment 4624059573); the behaviour predates that PR (owner path,
#2494) and is unchanged by it.

`confirmManualNodeDeletionRoute` lists the node's stranded tasks (`listStrandedNodeTasks`, which
selects tasks on `running`/`creating`/`recovery` workspaces), then writes the attested proof, which
marks every workspace on the node `deleted` (`markWorkspaceRuntimeTerminationConfirmed`), then runs
the removal tail (`completeOwnerNodeRemoval`). If the tail fails after the proof (audit insert,
route DNS cleanup, record removal), the in-memory task list is lost. A retry lists tasks again with
the same status filter and finds none, because the workspaces are now `deleted`. The unhealthy-node
sweep uses the same filter. The tasks stay `queued`/`delegated`/`in_progress`.

The operator path (`recordOperatorNodeDeletion`) is not affected in practice: its admission refuses
a node with any active or pending workspace.

## Acceptance criteria

- [ ] A retry of an interrupted attested removal still terminalizes the tasks that were active
      before the proof (persist them, or select them by a predicate the proof does not change).
- [ ] Tasks on workspaces that were never active are not terminalized by this path.
- [ ] Owner and operator routes keep sharing one removal path (`completeAttestedNodeRemoval`).
- [ ] A Workers test interrupts the tail after the proof, retries, and asserts the task is terminal.
