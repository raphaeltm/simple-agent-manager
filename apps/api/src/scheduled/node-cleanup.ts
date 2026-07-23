/**
 * Cron handler for warm node cleanup sweep (Layer 2 defense).
 *
 * Three-layer defense against orphaned nodes:
 * 1. DO alarm — primary mechanism (NodeLifecycle DO schedules self-destruct)
 * 2. Cron sweep — catches nodes missed by alarm failures (this file)
 * 3. Max lifetime — hard cap on auto-provisioned node age (prevents unbounded cost)
 *
 * The sweep queries D1 for:
 * - Stale warm nodes (warm_since < now - grace_period) with no active workspaces
 * - Auto-provisioned nodes exceeding max lifetime
 * - Orphaned workspaces (running with no associated active task) [TDF-7]
 * - Orphaned nodes (running with no workspaces past warm timeout) [TDF-7]
 *
 * It then destroys the nodes via the existing deleteNodeResources service.
 *
 * TDF-7: Enhanced with OBSERVABILITY_DATABASE recording for all cleanup
 * actions and orphan resource detection.
 *
 * See: specs/021-task-chat-architecture/tasks.md (T045-T047)
 */
import {
  DEFAULT_MAX_AUTO_NODE_LIFETIME_MS,
  DEFAULT_NODE_WARM_GRACE_PERIOD_MS,
  DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS,
  DEFAULT_WORKSPACE_STOPPED_TTL_MS,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { deleteWorkspaceOnNode, stopWorkspaceOnNode } from '../services/node-agent';
import { deleteNodeResources, stopNodeResources } from '../services/nodes';
import { persistError } from '../services/observability';
import * as projectDataService from '../services/project-data';

const DEFAULT_CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT = 25;

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface NodeCleanupResult {
  staleDestroyed: number;
  lifetimeDestroyed: number;
  lifetimeSkipped: number;
  orphanedWorkspacesFlagged: number;
  orphanedNodesFlagged: number;
  stoppedWorkspacesDeleted: number;
  cfContainersDestroyed: number;
  errors: number;
}

type CleanupContext = Record<string, string | number | null | undefined>;

async function destroyAutoProvisionedNodeForCleanup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  nowIso: string,
  node: { id: string; user_id: string },
  options: {
    logEvent: string;
    failureLogEvent: string;
    successMessage: string;
    failureMessagePrefix: string;
    recoveryType: string;
    failureRecoveryType: string;
    context: CleanupContext;
  }
): Promise<boolean> {
  try {
    log.info(options.logEvent, {
      nodeId: node.id,
      userId: node.user_id,
      ...options.context,
    });

    await deleteNodeResources(node.id, node.user_id, env);

    await persistError(env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'warn',
      message: options.successMessage,
      context: {
        recoveryType: options.recoveryType,
        nodeId: node.id,
        ...options.context,
      },
      userId: node.user_id,
      nodeId: node.id,
    });

    await db
      .update(schema.nodes)
      .set({ status: 'deleted', warmSince: null, healthStatus: 'stale', updatedAt: nowIso })
      .where(eq(schema.nodes.id, node.id));

    return true;
  } catch (err) {
    log.error(options.failureLogEvent, {
      nodeId: node.id,
      userId: node.user_id,
      error: err instanceof Error ? err.message : String(err),
    });

    await persistError(env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'error',
      message:
        options.failureMessagePrefix + ': ' + (err instanceof Error ? err.message : String(err)),
      stack: err instanceof Error ? err.stack : undefined,
      context: {
        recoveryType: options.failureRecoveryType,
        nodeId: node.id,
        ...options.context,
      },
      userId: node.user_id,
      nodeId: node.id,
    });

    return false;
  }
}

/**
 * Run the node cleanup sweep. Called from the cron handler.
 */
export async function runNodeCleanupSweep(env: Env): Promise<NodeCleanupResult> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date();
  const result: NodeCleanupResult = {
    staleDestroyed: 0,
    lifetimeDestroyed: 0,
    lifetimeSkipped: 0,
    orphanedWorkspacesFlagged: 0,
    orphanedNodesFlagged: 0,
    stoppedWorkspacesDeleted: 0,
    cfContainersDestroyed: 0,
    errors: 0,
  };

  const gracePeriodMs = parseMs(env.NODE_WARM_GRACE_PERIOD_MS, DEFAULT_NODE_WARM_GRACE_PERIOD_MS);
  const maxLifetimeMs = parseMs(env.MAX_AUTO_NODE_LIFETIME_MS, DEFAULT_MAX_AUTO_NODE_LIFETIME_MS);
  const orphanGracePeriodMs = parseMs(
    env.ORPHANED_WORKSPACE_GRACE_PERIOD_MS,
    DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS
  );
  const cfContainerSweepLimit = parsePositiveInt(
    env.CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT,
    DEFAULT_CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT
  );

  // Control-loop budget: this cf-container safety net selects at most
  // CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT terminal task-backed containers per
  // 5-minute cron run. Each candidate gets one Container destroy request through
  // stopNodeResources(), and success marks the node/workspaces deleted so it
  // leaves the candidate set.
  const terminalCfContainerWorkspaces = await env.DATABASE.prepare(
    `SELECT DISTINCT n.id as node_id, n.user_id, w.id as workspace_id, t.id as task_id, t.status as task_status
     FROM nodes n
     INNER JOIN workspaces w ON w.node_id = n.id
     INNER JOIN tasks t ON t.workspace_id = w.id
     WHERE n.runtime = 'cf-container'
       AND n.status NOT IN ('deleted', 'stopped')
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND w.status IN ('running', 'creating', 'recovery', 'sleeping', 'stopped')
       AND t.status IN ('completed', 'failed', 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM tasks active
         WHERE active.workspace_id = w.id
           AND active.status IN ('queued', 'delegated', 'in_progress')
       )
       AND t.updated_at < ?
     ORDER BY t.updated_at ASC
     LIMIT ?`
  )
    .bind(new Date(now.getTime() - orphanGracePeriodMs).toISOString(), cfContainerSweepLimit)
    .all<{
      node_id: string;
      user_id: string;
      workspace_id: string;
      task_id: string;
      task_status: string;
    }>();

  for (const candidate of terminalCfContainerWorkspaces.results) {
    try {
      log.warn('node_cleanup.cf_container_terminal_task_destroying', {
        nodeId: candidate.node_id,
        workspaceId: candidate.workspace_id,
        taskId: candidate.task_id,
        taskStatus: candidate.task_status,
      });

      await stopNodeResources(candidate.node_id, candidate.user_id, env);

      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: 'Destroyed cf-container node left behind after terminal task',
        context: {
          recoveryType: 'cf_container_terminal_task_cleanup',
          nodeId: candidate.node_id,
          workspaceId: candidate.workspace_id,
          taskId: candidate.task_id,
          taskStatus: candidate.task_status,
          gracePeriodMs: orphanGracePeriodMs,
        },
        userId: candidate.user_id,
        nodeId: candidate.node_id,
        workspaceId: candidate.workspace_id,
      });

      result.cfContainersDestroyed++;
    } catch (err) {
      log.error('node_cleanup.cf_container_terminal_task_destroy_failed', {
        nodeId: candidate.node_id,
        workspaceId: candidate.workspace_id,
        taskId: candidate.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }

  // 1. Find stale warm nodes with running workspace counts in a single query
  //    to avoid N+1 per-node workspace count lookups.
  const staleThreshold = new Date(now.getTime() - gracePeriodMs).toISOString();
  const staleWarmNodesWithCounts = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.warm_since,
            COUNT(CASE WHEN w.status = 'running' THEN 1 END) as running_ws_count
     FROM nodes n
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.warm_since IS NOT NULL
       AND n.warm_since < ?
       AND n.status = 'running'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
     GROUP BY n.id, n.user_id, n.warm_since`
  )
    .bind(staleThreshold)
    .all<{
      id: string;
      user_id: string;
      warm_since: string;
      running_ws_count: number;
    }>();

  for (const node of staleWarmNodesWithCounts.results) {
    if (node.running_ws_count > 0) {
      // Has active workspaces — clear warm_since (shouldn't be warm)
      await db
        .update(schema.nodes)
        .set({ warmSince: null, updatedAt: now.toISOString() })
        .where(eq(schema.nodes.id, node.id));
      continue;
    }

    try {
      log.info('node_cleanup.destroying_stale_warm', {
        nodeId: node.id,
        userId: node.user_id,
        warmSince: node.warm_since,
      });

      await deleteNodeResources(node.id, node.user_id, env);

      // Record successful cleanup in OBSERVABILITY_DATABASE (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'info',
        message: `Destroyed stale warm node (Layer 2 defense)`,
        context: {
          recoveryType: 'stale_warm_node_cleanup',
          nodeId: node.id,
          warmSince: node.warm_since,
          gracePeriodMs,
        },
        userId: node.user_id,
        nodeId: node.id,
      });
      await db
        .update(schema.nodes)
        .set({
          status: 'deleted',
          warmSince: null,
          healthStatus: 'stale',
          updatedAt: now.toISOString(),
        })
        .where(eq(schema.nodes.id, node.id));
      result.staleDestroyed++;
    } catch (err) {
      log.error('node_cleanup.stale_warm_destroy_failed', {
        nodeId: node.id,
        userId: node.user_id,
        error: err instanceof Error ? err.message : String(err),
      });

      // Record failure in OBSERVABILITY_DATABASE (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'error',
        message: `Failed to destroy stale warm node: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          recoveryType: 'stale_warm_node_cleanup_failure',
          nodeId: node.id,
          warmSince: node.warm_since,
        },
        userId: node.user_id,
        nodeId: node.id,
      });

      result.errors++;
    }
  }

  // 2. Find auto-provisioned nodes exceeding max lifetime
  //    Nodes with active workspaces are ALWAYS skipped — workspace-level idle
  //    detection (via ProjectData DO) handles cleanup at a finer granularity.
  //    The absolute ceiling was removed; workspace idle timeouts prevent unbounded cost.
  const lifetimeThreshold = new Date(now.getTime() - maxLifetimeMs).toISOString();

  const autoProvisionedNodesWithCounts = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at,
            COUNT(DISTINCT CASE WHEN w.status IN ('running', 'creating', 'recovery') THEN w.id END) as active_ws_count
     FROM nodes n
     INNER JOIN tasks t ON t.auto_provisioned_node_id = n.id
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE t.auto_provisioned_node_id IS NOT NULL
       AND n.status NOT IN ('stopped', 'deleted')
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND n.created_at < ?
     GROUP BY n.id, n.user_id, n.status, n.created_at`
  )
    .bind(lifetimeThreshold)
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      active_ws_count: number;
    }>();

  for (const node of autoProvisionedNodesWithCounts.results) {
    if (node.active_ws_count > 0) {
      // Node has active workspaces — skip. Workspace idle detection handles cleanup.
      log.info('node_cleanup.max_lifetime_skipped_active_workspaces', {
        nodeId: node.id,
        userId: node.user_id,
        activeWorkspaces: node.active_ws_count,
        createdAt: node.created_at,
        maxLifetimeMs,
      });

      result.lifetimeSkipped++;
      continue;
    }

    const destroyed = await destroyAutoProvisionedNodeForCleanup(db, env, now.toISOString(), node, {
      logEvent: 'node_cleanup.destroying_max_lifetime',
      failureLogEvent: 'node_cleanup.max_lifetime_destroy_failed',
      successMessage:
        'Destroyed auto-provisioned node exceeding max lifetime (no active workspaces)',
      failureMessagePrefix: 'Failed to destroy max-lifetime node',
      recoveryType: 'max_lifetime_node_cleanup',
      failureRecoveryType: 'max_lifetime_node_cleanup_failure',
      context: { createdAt: node.created_at, maxLifetimeMs },
    });

    if (destroyed) {
      result.lifetimeDestroyed++;
    } else {
      result.errors++;
    }
  }

  // 3. Destroy stopped auto-provisioned nodes left by the NodeLifecycle alarm.
  //    The DO alarm transitions warm nodes to D1 status='stopped' and clears
  //    warm_since. Without this handoff phase, those nodes no longer match the
  //    stale-warm query above and are skipped by max-lifetime cleanup.
  const stoppedHandoffThreshold = new Date(now.getTime() - orphanGracePeriodMs).toISOString();
  const stoppedHandoffNodes = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at, n.updated_at,
            COUNT(DISTINCT CASE WHEN w.status IN ('running', 'creating', 'recovery') THEN w.id END) as active_ws_count
     FROM nodes n
     INNER JOIN tasks t ON t.auto_provisioned_node_id = n.id
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.status = 'stopped'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND n.created_at < ?
     GROUP BY n.id, n.user_id, n.status, n.created_at, n.updated_at`
  )
    .bind(stoppedHandoffThreshold)
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      updated_at: string;
      active_ws_count: number;
    }>();

  for (const node of stoppedHandoffNodes.results) {
    if (node.active_ws_count > 0) {
      log.warn('node_cleanup.stopped_handoff_skipped_active_workspaces', {
        nodeId: node.id,
        userId: node.user_id,
        activeWorkspaces: node.active_ws_count,
        updatedAt: node.updated_at,
      });
      result.lifetimeSkipped++;
      continue;
    }

    const destroyed = await destroyAutoProvisionedNodeForCleanup(db, env, now.toISOString(), node, {
      logEvent: 'node_cleanup.destroying_stopped_handoff',
      failureLogEvent: 'node_cleanup.stopped_handoff_destroy_failed',
      successMessage: 'Destroyed stopped auto-provisioned node left by NodeLifecycle alarm',
      failureMessagePrefix: 'Failed to destroy stopped handoff node',
      recoveryType: 'stopped_node_handoff_cleanup',
      failureRecoveryType: 'stopped_node_handoff_cleanup_failure',
      context: {
        createdAt: node.created_at,
        updatedAt: node.updated_at,
        gracePeriodMs: orphanGracePeriodMs,
      },
    });

    if (destroyed) {
      result.lifetimeDestroyed++;
    } else {
      result.errors++;
    }
  }

  // 4. Orphan cleanup: task-created workspaces still active after task ended (TDF-7)
  //    Only checks workspaces that were EVER associated with a task (via tasks.workspace_id).
  //    User-created workspaces (never referenced by any task) are excluded — they are
  //    intentionally long-lived and not orphans.
  const orphanedWorkspaces = await env.DATABASE.prepare(
    `SELECT w.id, w.node_id, w.user_id, w.status, w.created_at, w.project_id, w.chat_session_id
     FROM workspaces w
     WHERE w.status IN ('running', 'creating', 'recovery')
       AND EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.workspace_id = w.id
           AND t.status IN ('completed', 'failed', 'cancelled')
       )
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.workspace_id = w.id
           AND t.status IN ('queued', 'delegated', 'in_progress')
       )
       AND w.created_at < ?`
  )
    .bind(new Date(now.getTime() - orphanGracePeriodMs).toISOString())
    .all<{
      id: string;
      node_id: string | null;
      user_id: string;
      status: string;
      created_at: string;
      project_id: string | null;
      chat_session_id: string | null;
    }>();

  for (const ws of orphanedWorkspaces.results) {
    log.warn('node_cleanup.orphaned_workspace_stopping', {
      workspaceId: ws.id,
      nodeId: ws.node_id,
      userId: ws.user_id,
      createdAt: ws.created_at,
    });

    try {
      // Stop workspace on VM agent (best-effort)
      if (ws.node_id) {
        await stopWorkspaceOnNode(ws.node_id, ws.id, env, ws.user_id).catch((e) => {
          log.warn('node_cleanup.orphan_stop_on_node_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
      }

      // Mark workspace as stopped in D1
      await db
        .update(schema.workspaces)
        .set({ status: 'stopped', updatedAt: new Date().toISOString() })
        .where(eq(schema.workspaces.id, ws.id));

      // Stop the chat session and clean up activity tracking
      if (ws.project_id && ws.chat_session_id) {
        await projectDataService.stopSession(env, ws.project_id, ws.chat_session_id).catch((e) => {
          log.warn('node_cleanup.orphan_session_stop_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
        await projectDataService.cleanupWorkspaceActivity(env, ws.project_id, ws.id).catch((e) => {
          log.warn('node_cleanup.orphan_activity_cleanup_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
      }

      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: `Orphaned workspace stopped: was running with no active task`,
        context: {
          recoveryType: 'orphaned_workspace',
          workspaceId: ws.id,
          nodeId: ws.node_id,
          createdAt: ws.created_at,
        },
        userId: ws.user_id,
        nodeId: ws.node_id,
        workspaceId: ws.id,
      });

      result.orphanedWorkspacesFlagged++;
    } catch (e) {
      log.error('node_cleanup.orphan_workspace_stop_failed', {
        workspaceId: ws.id,
        error: String(e),
      });
      result.errors++;
    }
  }

  // 5. Orphan detection: running nodes with no workspaces past warm timeout (TDF-7)
  //    A node is orphaned if it's 'running' with no warm_since, no workspaces,
  //    and its updated_at is older than the grace period.
  const orphanedNodes = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.updated_at, n.warm_since
     FROM nodes n
     WHERE n.status = 'running'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND n.warm_since IS NULL
       AND n.updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.node_id = n.id
           AND w.status IN ('running', 'creating', 'recovery')
       )`
  )
    .bind(new Date(now.getTime() - orphanGracePeriodMs).toISOString())
    .all<{
      id: string;
      user_id: string;
      status: string;
      updated_at: string;
      warm_since: string | null;
    }>();

  for (const node of orphanedNodes.results) {
    log.warn('node_cleanup.orphaned_node_detected', {
      nodeId: node.id,
      userId: node.user_id,
      updatedAt: node.updated_at,
    });

    await persistError(env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'warn',
      message: `Orphaned node detected: running with no workspaces and not in warm pool`,
      context: {
        recoveryType: 'orphaned_node',
        nodeId: node.id,
        updatedAt: node.updated_at,
      },
      userId: node.user_id,
      nodeId: node.id,
    });

    result.orphanedNodesFlagged++;
  }

  // 6. Safety-net: delete stopped workspaces past TTL that the DO alarm missed.
  //    This catches cases where the DO alarm failed to fire or wasn't scheduled.
  const stoppedTtlMs = parseMs(env.WORKSPACE_STOPPED_TTL_MS, DEFAULT_WORKSPACE_STOPPED_TTL_MS);
  // Add a 2x grace buffer so the DO alarm has time to fire first
  const stoppedGraceThreshold = new Date(now.getTime() - stoppedTtlMs * 2).toISOString();
  const staleStoppedWorkspaces = await env.DATABASE.prepare(
    `SELECT w.id, w.node_id, w.user_id
     FROM workspaces w
     WHERE w.status = 'stopped'
       AND w.updated_at < ?
     LIMIT 50`
  )
    .bind(stoppedGraceThreshold)
    .all<{
      id: string;
      node_id: string | null;
      user_id: string;
    }>();

  for (const ws of staleStoppedWorkspaces.results) {
    try {
      // Delete on VM agent (best-effort — node may be gone)
      if (ws.node_id) {
        await deleteWorkspaceOnNode(ws.node_id, ws.id, env, ws.user_id).catch((e) => {
          log.warn('node_cleanup.stale_stopped_delete_on_node_failed', {
            workspaceId: ws.id,
            error: String(e),
          });
        });
      }

      // Mark as deleted in D1 (status guard prevents TOCTOU race if workspace was restarted)
      await db
        .update(schema.workspaces)
        .set({ status: 'deleted', updatedAt: new Date().toISOString() })
        .where(and(eq(schema.workspaces.id, ws.id), eq(schema.workspaces.status, 'stopped')));

      result.stoppedWorkspacesDeleted++;
    } catch (e) {
      log.error('node_cleanup.stale_stopped_workspace_delete_failed', {
        workspaceId: ws.id,
        error: String(e),
      });
      result.errors++;
    }
  }

  return result;
}
