/**
 * Bounded repair for D1 lifecycle rows that still look active after their node
 * is already terminal. This closes the accounting/session side effects without
 * waking or replaying work.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { finalizeWorkspaceLifecycleClosure } from '../services/workspace-lifecycle-finalizer';
import { parsePositiveInt } from './node-cleanup/shared';

interface TerminalNodeWorkspaceRow {
  workspace_id: string;
  node_id: string;
}

export interface TerminalNodeLifecycleRepairStats {
  selected: number;
  workspacesTerminalized: number;
  agentSessionsClosed: number;
  computeUsageClosed: number;
  projectSessionsClosed: number;
  projectSessionErrors: number;
  workspaceActivityCleaned: number;
  workspaceActivityErrors: number;
  errors: number;
}

function repairBatchSize(env: Env): number {
  return Math.min(500, Math.max(1, parsePositiveInt(env.TERMINAL_NODE_LIFECYCLE_REPAIR_BATCH_SIZE, 100)));
}

export async function runTerminalNodeLifecycleRepair(
  env: Env
): Promise<TerminalNodeLifecycleRepairStats> {
  const limit = repairBatchSize(env);
  const rows = await env.DATABASE.prepare(
    `SELECT w.id AS workspace_id, w.node_id AS node_id
       FROM workspaces w
       INNER JOIN nodes n ON n.id = w.node_id
      WHERE n.status IN ('stopped', 'deleted', 'destroyed', 'error')
        AND w.status NOT IN ('sleeping', 'stopped', 'deleted', 'error')
      ORDER BY w.updated_at ASC
      LIMIT ?`
  )
    .bind(limit)
    .all<TerminalNodeWorkspaceRow>();

  const stats: TerminalNodeLifecycleRepairStats = {
    selected: rows.results.length,
    workspacesTerminalized: 0,
    agentSessionsClosed: 0,
    computeUsageClosed: 0,
    projectSessionsClosed: 0,
    projectSessionErrors: 0,
    workspaceActivityCleaned: 0,
    workspaceActivityErrors: 0,
    errors: 0,
  };

  for (const row of rows.results) {
    try {
      const result = await finalizeWorkspaceLifecycleClosure(env, {
        workspaceIds: [row.workspace_id],
        agentSessionStatus: 'stopped',
        workspaceStatus: 'stopped',
        reason: 'terminal_node_lifecycle_repair',
      });
      stats.workspacesTerminalized += result.workspacesTerminalized;
      stats.agentSessionsClosed += result.agentSessionsClosed;
      stats.computeUsageClosed += result.computeUsageClosed;
      stats.projectSessionsClosed += result.projectSessionsClosed;
      stats.projectSessionErrors += result.projectSessionErrors;
      stats.workspaceActivityCleaned += result.workspaceActivityCleaned;
      stats.workspaceActivityErrors += result.workspaceActivityErrors;
    } catch (error) {
      stats.errors++;
      log.warn('terminal_node_lifecycle_repair.workspace_failed', {
        workspaceId: row.workspace_id,
        nodeId: row.node_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (
    stats.workspacesTerminalized > 0 ||
    stats.agentSessionsClosed > 0 ||
    stats.computeUsageClosed > 0 ||
    stats.projectSessionsClosed > 0 ||
    stats.errors > 0
  ) {
    log.info('terminal_node_lifecycle_repair.completed', { ...stats });
  }

  return stats;
}
