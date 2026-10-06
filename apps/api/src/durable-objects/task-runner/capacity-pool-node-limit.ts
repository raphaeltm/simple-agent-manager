import { DEFAULT_CAPACITY_POOL_MAX_NODES } from '@simple-agent-manager/shared';

import type { TaskRunnerContext, TaskRunnerState } from './types';

export function effectiveCapacityPoolMaxNodes(state: TaskRunnerState): number | null {
  const selection = state.config.capacityPoolSelection;
  if (!selection) return null;
  const configured = selection.maxNodes ?? DEFAULT_CAPACITY_POOL_MAX_NODES;
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CAPACITY_POOL_MAX_NODES;
}

export async function countActiveManagedPoolNodes(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<number | null> {
  const selection = state.config.capacityPoolSelection;
  if (!selection) return null;
  const row = await rc.env.DATABASE.prepare(
    `SELECT COUNT(*) AS count
       FROM nodes
      WHERE user_id = ?
        AND capacity_pool_id = ?
        AND status IN ('running', 'creating', 'recovery')
        AND node_role = 'workspace'
        AND node_class != 'user-owned'`
  )
    .bind(state.userId, selection.poolId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function shouldProvisionSpreadNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<boolean> {
  if (state.config.capacityPoolSelection?.strategy !== 'spread') return false;
  const [count, maxNodes] = await Promise.all([
    countActiveManagedPoolNodes(state, rc),
    Promise.resolve(effectiveCapacityPoolMaxNodes(state)),
  ]);
  return shouldProvisionSpreadNodeForCount(
    state.config.capacityPoolSelection?.strategy,
    count,
    maxNodes
  );
}

export function shouldProvisionSpreadNodeForCount(
  strategy: string | null | undefined,
  activePoolNodes: number | null,
  maxNodes: number | null
): boolean {
  return (
    strategy === 'spread' &&
    activePoolNodes !== null &&
    maxNodes !== null &&
    activePoolNodes < maxNodes
  );
}
