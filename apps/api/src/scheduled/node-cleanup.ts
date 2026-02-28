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
import { eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  DEFAULT_NODE_WARM_GRACE_PERIOD_MS,
  DEFAULT_MAX_AUTO_NODE_LIFETIME_MS,
} from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { deleteNodeResources } from '../services/nodes';
import { log } from '../lib/logger';
import { persistError } from '../services/observability';

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface NodeCleanupResult {
  staleDestroyed: number;
  lifetimeDestroyed: number;
  orphanedWorkspacesFlagged: number;
  orphanedNodesFlagged: number;
  errors: number;
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
    orphanedWorkspacesFlagged: 0,
    orphanedNodesFlagged: 0,
    errors: 0,
  };

  const gracePeriodMs = parseMs(env.NODE_WARM_GRACE_PERIOD_MS, DEFAULT_NODE_WARM_GRACE_PERIOD_MS);
  const maxLifetimeMs = parseMs(env.MAX_AUTO_NODE_LIFETIME_MS, DEFAULT_MAX_AUTO_NODE_LIFETIME_MS);

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
     GROUP BY n.id`
  ).bind(staleThreshold).all<{
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
      log.info('node_cleanup.destroying_stale_warm', { nodeId: node.id, userId: node.user_id, warmSince: node.warm_since });

      // Record in OBSERVABILITY_DATABASE (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'info',
        message: `Destroying stale warm node (Layer 2 defense)`,
        context: {
          recoveryType: 'stale_warm_node_cleanup',
          nodeId: node.id,
          warmSince: node.warm_since,
          gracePeriodMs,
        },
        userId: node.user_id,
        nodeId: node.id,
      });

      await deleteNodeResources(node.id, node.user_id, env);
      await db
        .update(schema.nodes)
        .set({ status: 'stopped', warmSince: null, healthStatus: 'stale', updatedAt: now.toISOString() })
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
  const lifetimeThreshold = new Date(now.getTime() - maxLifetimeMs).toISOString();

  // Auto-provisioned nodes are those referenced by tasks.autoProvisionedNodeId
  const autoProvisionedNodes = await db
    .select({
      nodeId: schema.tasks.autoProvisionedNodeId,
    })
    .from(schema.tasks)
    .where(isNotNull(schema.tasks.autoProvisionedNodeId))
    .groupBy(schema.tasks.autoProvisionedNodeId);

  for (const { nodeId } of autoProvisionedNodes) {
    if (!nodeId) continue;

    const [node] = await db
      .select({
        id: schema.nodes.id,
        userId: schema.nodes.userId,
        status: schema.nodes.status,
        createdAt: schema.nodes.createdAt,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .limit(1);

    if (!node || node.status === 'stopped') continue;
    if (node.createdAt > lifetimeThreshold) continue; // Not past max lifetime

    // Node exceeds max lifetime — destroy regardless
    try {
      log.info('node_cleanup.destroying_max_lifetime', { nodeId: node.id, userId: node.userId, createdAt: node.createdAt });

      // Record in OBSERVABILITY_DATABASE (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: `Destroying auto-provisioned node exceeding max lifetime (Layer 3 defense)`,
        context: {
          recoveryType: 'max_lifetime_node_cleanup',
          nodeId: node.id,
          createdAt: node.createdAt,
          maxLifetimeMs,
        },
        userId: node.userId,
        nodeId: node.id,
      });

      await deleteNodeResources(node.id, node.userId, env);
      await db
        .update(schema.nodes)
        .set({ status: 'stopped', warmSince: null, healthStatus: 'stale', updatedAt: now.toISOString() })
        .where(eq(schema.nodes.id, node.id));
      result.lifetimeDestroyed++;
    } catch (err) {
      log.error('node_cleanup.max_lifetime_destroy_failed', {
        nodeId: node.id,
        userId: node.userId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Record failure in OBSERVABILITY_DATABASE (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'error',
        message: `Failed to destroy max-lifetime node: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          recoveryType: 'max_lifetime_node_cleanup_failure',
          nodeId: node.id,
          createdAt: node.createdAt,
        },
        userId: node.userId,
        nodeId: node.id,
      });

      result.errors++;
    }
  }

  // 3. Orphan detection: workspaces running with no associated active task (TDF-7)
  //    A workspace is orphaned if it's in 'running' status but no task in
  //    'queued'/'delegated'/'in_progress' references it via workspace_id.
  const orphanedWorkspaces = await env.DATABASE.prepare(
    `SELECT w.id, w.node_id, w.user_id, w.status, w.created_at
     FROM workspaces w
     WHERE w.status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.workspace_id = w.id
           AND t.status IN ('queued', 'delegated', 'in_progress')
       )
       AND w.created_at < ?`
  ).bind(new Date(now.getTime() - gracePeriodMs).toISOString()).all<{
    id: string;
    node_id: string | null;
    user_id: string;
    status: string;
    created_at: string;
  }>();

  for (const ws of orphanedWorkspaces.results) {
    log.warn('node_cleanup.orphaned_workspace_detected', {
      workspaceId: ws.id,
      nodeId: ws.node_id,
      userId: ws.user_id,
      createdAt: ws.created_at,
    });

    await persistError(env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'warn',
      message: `Orphaned workspace detected: running with no active task`,
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
  }

  // 4. Orphan detection: running nodes with no workspaces past warm timeout (TDF-7)
  //    A node is orphaned if it's 'running' with no warm_since, no workspaces,
  //    and its updated_at is older than the grace period.
  const orphanedNodes = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.updated_at, n.warm_since
     FROM nodes n
     WHERE n.status = 'running'
       AND n.warm_since IS NULL
       AND n.updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.node_id = n.id
           AND w.status IN ('running', 'creating', 'recovery')
       )`
  ).bind(new Date(now.getTime() - gracePeriodMs).toISOString()).all<{
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

  return result;
}
