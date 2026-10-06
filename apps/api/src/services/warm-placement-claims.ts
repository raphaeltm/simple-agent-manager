/**
 * Bounded placement-race guard for warm-node reuse.
 *
 * NodeLifecycle persists `tasks.claimed_warm_node_id` before TaskRunner inserts
 * the `workspaces.status='creating'` row. During that short cross-store window,
 * the workspace-activity clock alone cannot see the pending placement on an old
 * warm node. This guard protects only claims written within the same finite
 * workspace-idle window; an abandoned claim ages out and cannot create another
 * immortal candidate set.
 */
export function boundedWarmPlacementClaimGuardSql(nodeIdSql: string): string {
  return `AND NOT EXISTS (
    SELECT 1
    FROM tasks placement_claim
    WHERE placement_claim.claimed_warm_node_id = ${nodeIdSql}
      AND placement_claim.status IN ('queued', 'delegated', 'in_progress')
      AND placement_claim.claimed_warm_node_at IS NOT NULL
      AND placement_claim.claimed_warm_node_at >= ?
  )`;
}
