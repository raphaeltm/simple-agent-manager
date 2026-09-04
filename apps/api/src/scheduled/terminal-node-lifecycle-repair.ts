/**
 * Bounded repair for D1 lifecycle rows that still look active after their node
 * is already terminal. This closes the accounting/session side effects without
 * waking or replaying work.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { findRestorableOrInFlightSleepSnapshot } from '../services/session-snapshot-sleep-predicate';
import { cleanupWorkspaceForDeletion } from '../services/workspace-cleanup';
import { parsePositiveInt } from './node-cleanup/shared';

interface TerminalNodeWorkspaceRow {
  workspace_id: string;
  node_id: string;
  project_id: string | null;
  chat_session_id: string | null;
  user_id: string;
  status: string;
}

export interface TerminalNodeLifecycleRepairStats {
  selected: number;
  skippedProtectedSleep: number;
  workspacesTerminalized: number;
  agentSessionsClosed: number;
  computeUsageClosed: number;
  projectSessionsClosed: number;
  projectSessionErrors: number;
  workspaceActivityCleaned: number;
  workspaceActivityErrors: number;
  errors: number;
  budgetExhausted: boolean;
}

const DEFAULT_TERMINAL_NODE_LIFECYCLE_REPAIR_BATCH_SIZE = 25;
const DEFAULT_TERMINAL_NODE_LIFECYCLE_REPAIR_WALL_BUDGET_MS = 10_000;
const MAX_TERMINAL_NODE_LIFECYCLE_REPAIR_BATCH_SIZE = 100;
const MAX_TERMINAL_NODE_LIFECYCLE_REPAIR_WALL_BUDGET_MS = 30_000;
const ACTIVE_WORKSPACE_STATUSES = [
  'pending',
  'creating',
  'running',
  'recovery',
  'stopping',
] as const;

function repairBatchSize(env: Env): number {
  return Math.min(
    MAX_TERMINAL_NODE_LIFECYCLE_REPAIR_BATCH_SIZE,
    Math.max(
      1,
      parsePositiveInt(
        env.TERMINAL_NODE_LIFECYCLE_REPAIR_BATCH_SIZE,
        DEFAULT_TERMINAL_NODE_LIFECYCLE_REPAIR_BATCH_SIZE
      )
    )
  );
}

function repairWallBudgetMs(env: Env): number {
  return Math.min(
    MAX_TERMINAL_NODE_LIFECYCLE_REPAIR_WALL_BUDGET_MS,
    Math.max(
      1_000,
      parsePositiveInt(
        env.TERMINAL_NODE_LIFECYCLE_REPAIR_WALL_BUDGET_MS,
        DEFAULT_TERMINAL_NODE_LIFECYCLE_REPAIR_WALL_BUDGET_MS
      )
    )
  );
}

export async function runTerminalNodeLifecycleRepair(
  env: Env
): Promise<TerminalNodeLifecycleRepairStats> {
  const startedAt = Date.now();
  const limit = repairBatchSize(env);
  const rows = await env.DATABASE.prepare(
    `SELECT w.id AS workspace_id, w.node_id AS node_id, w.user_id AS user_id,
            w.project_id AS project_id, w.chat_session_id AS chat_session_id,
            w.status AS status
      FROM workspaces w
      INNER JOIN nodes n ON n.id = w.node_id
      WHERE n.status IN ('stopped', 'deleted', 'destroyed', 'error')
        AND w.status IN (${ACTIVE_WORKSPACE_STATUSES.map(() => '?').join(', ')})
      ORDER BY w.updated_at ASC
      LIMIT ?`
  )
    .bind(...ACTIVE_WORKSPACE_STATUSES, limit)
    .all<TerminalNodeWorkspaceRow>();

  const stats: TerminalNodeLifecycleRepairStats = {
    selected: rows.results.length,
    skippedProtectedSleep: 0,
    workspacesTerminalized: 0,
    agentSessionsClosed: 0,
    computeUsageClosed: 0,
    projectSessionsClosed: 0,
    projectSessionErrors: 0,
    workspaceActivityCleaned: 0,
    workspaceActivityErrors: 0,
    errors: 0,
    budgetExhausted: false,
  };

  for (const row of rows.results) {
    if (Date.now() - startedAt >= repairWallBudgetMs(env)) {
      stats.budgetExhausted = true;
      break;
    }
    try {
      if (row.project_id && row.chat_session_id) {
        const protectedSleep = await findRestorableOrInFlightSleepSnapshot(env.DATABASE, env, {
          projectId: row.project_id,
          workspaceId: row.workspace_id,
          chatSessionId: row.chat_session_id,
        });
        if (protectedSleep) {
          stats.skippedProtectedSleep++;
          continue;
        }
      }
      const outcome = await cleanupWorkspaceForDeletion({
        db: drizzle(env.DATABASE, { schema }),
        env,
        workspace: {
          id: row.workspace_id,
          nodeId: row.node_id,
          userId: row.user_id,
          projectId: row.project_id,
          chatSessionId: row.chat_session_id,
          status: row.status,
        } as schema.Workspace,
        userId: row.user_id,
        deleteConfirmedRow: false,
        logContext: { closePath: 'terminal_node_lifecycle_repair' },
      });
      if (outcome.status === 'confirmed') {
        stats.workspacesTerminalized++;
        stats.agentSessionsClosed += outcome.lifecycle?.agentSessionsClosed ?? 0;
        stats.computeUsageClosed += outcome.lifecycle?.computeUsageClosed ?? 0;
        stats.projectSessionsClosed += outcome.lifecycle?.projectSessionsClosed ?? 0;
        stats.projectSessionErrors += outcome.lifecycle?.projectSessionErrors ?? 0;
        stats.workspaceActivityCleaned += outcome.lifecycle?.workspaceActivityCleaned ?? 0;
        stats.workspaceActivityErrors += outcome.lifecycle?.workspaceActivityErrors ?? 0;
      } else {
        stats.errors++;
      }
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
    stats.errors > 0 ||
    stats.budgetExhausted
  ) {
    log.info('terminal_node_lifecycle_repair.completed', { ...stats });
  }

  return stats;
}
