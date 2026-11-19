import type { PlacementAuthoritySqlPredicate } from './placement-authority';

/**
 * Reserve a task's provisioned node until placement or a terminal lifecycle state.
 * Exclude the whole host to preserve exclusive and legacy reservations too.
 * Applies at workspace admission, not node allocation validation during boot.
 * The existing partial auto_provisioned_node_id index bounds each host lookup.
 */
export function buildProvisionedNodeHoldSqlPredicate(
  nodeAlias: string,
  requestingTaskId?: string | null
): PlacementAuthoritySqlPredicate {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nodeAlias)) throw new Error('Unsafe SQL alias');
  const alias = nodeAlias;
  return {
    sql: `AND NOT EXISTS (
      SELECT 1 FROM tasks provisioned_node_owner
      WHERE provisioned_node_owner.auto_provisioned_node_id = ${alias}.id
        AND provisioned_node_owner.workspace_id IS NULL
        AND provisioned_node_owner.status IN ('queued', 'delegated', 'in_progress')
        AND provisioned_node_owner.id IS NOT ?
    )`,
    binds: [requestingTaskId ?? null],
  };
}
