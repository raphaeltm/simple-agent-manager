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
 *
 * It then destroys the nodes via the existing deleteNodeResources service.
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

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface NodeCleanupResult {
  staleDestroyed: number;
  lifetimeDestroyed: number;
  errors: number;
}

/**
 * Run the node cleanup sweep. Called from the cron handler.
 */
export async function runNodeCleanupSweep(env: Env): Promise<NodeCleanupResult> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date();
  const result: NodeCleanupResult = { staleDestroyed: 0, lifetimeDestroyed: 0, errors: 0 };

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
      result.errors++;
    }
  }

  return result;
}
