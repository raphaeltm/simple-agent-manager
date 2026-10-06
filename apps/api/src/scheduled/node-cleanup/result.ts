export interface NodeCleanupResult {
  staleDestroyed: number;
  lifetimeDestroyed: number;
  lifetimeSkipped: number;
  orphanedWorkspacesFlagged: number;
  /**
   * Orphaned running nodes actually destroyed. Replaces the old
   * `orphanedNodesFlagged`, which only ever counted observability rows — the
   * phase detected orphans and then left them running forever.
   */
  orphanedNodesDestroyed: number;
  orphanedNodesSkipped: number;
  stoppedWorkspacesQueued: number;
  stoppedWorkspacesDeleted: number;
  cfContainersDestroyed: number;
  incompatibleDestroyed: number;
  incompatibleSkipped: number;
  unhealthyReleased: number;
  unhealthyHeld: number;
  errors: number;
}

export function emptyResult(): NodeCleanupResult {
  return {
    staleDestroyed: 0,
    lifetimeDestroyed: 0,
    lifetimeSkipped: 0,
    orphanedWorkspacesFlagged: 0,
    orphanedNodesDestroyed: 0,
    orphanedNodesSkipped: 0,
    stoppedWorkspacesQueued: 0,
    stoppedWorkspacesDeleted: 0,
    cfContainersDestroyed: 0,
    incompatibleDestroyed: 0,
    incompatibleSkipped: 0,
    unhealthyReleased: 0,
    unhealthyHeld: 0,
    errors: 0,
  };
}
