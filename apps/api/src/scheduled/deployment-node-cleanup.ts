/** Backstop for interrupted deployment teardown; never reaps running deployments. */
import { DEPLOYMENT_STOP_ERROR_PREFIX } from '@simple-agent-manager/shared';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { recoverLegacyDeploymentBinding } from '../services/deployment-legacy-binding';
import { cleanupDeploymentNode } from '../services/deployment-node-cleanup';
import { recoverInterruptedDeploymentStops } from './deployment-stop-recovery';
import { resolveCleanupConfig } from './node-cleanup/config';

export async function runDeploymentNodeCleanup(
  env: Env,
  waitUntil?: (work: Promise<unknown>) => void
): Promise<{ deleted: number; failed: number }> {
  await recoverInterruptedDeploymentStops(env, waitUntil);
  const config = resolveCleanupConfig(env);
  const deadline = Date.now() + config.stoppedHandoffSweepBudgetMs;
  const now = new Date().toISOString();
  const rows = await env.DATABASE.prepare(
    `SELECT id, user_id AS userId FROM nodes n
     WHERE n.node_role = 'deployment' AND n.node_class = 'managed' AND n.runtime = 'vm'
       AND (n.status IN ('destroying', 'deleting', 'error') OR
         (n.status = 'deleted' AND n.runtime_termination_confirmed_at IS NOT NULL AND EXISTS (
           SELECT 1 FROM deployment_environments pending WHERE pending.node_id = n.id
         )))
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       AND NOT EXISTS (
         SELECT 1 FROM deployment_environments de WHERE de.node_id = n.id
           AND NOT (de.status = 'stopping' OR (de.status = 'error'
             AND substr(de.observed_error_message, 1, length(?)) = ?))
       )
     ORDER BY n.updated_at, n.id LIMIT ?`
  )
    .bind(now, DEPLOYMENT_STOP_ERROR_PREFIX, DEPLOYMENT_STOP_ERROR_PREFIX, config.nodeSweepLimit)
    .all<{ id: string; userId: string }>();
  const result = { deleted: 0, failed: 0 };
  for (const node of rows.results) {
    if (Date.now() >= deadline) break;
    // Persist eligibility before network I/O so process interruption also backs
    // off. Claim again atomically against consumer status inside the operation.
    await env.DATABASE.prepare(
      `UPDATE deployment_environments SET status = 'stopping', updated_at = ?
       WHERE node_id = ? AND status = 'error'
         AND substr(observed_error_message, 1, length(?)) = ?`
    )
      .bind(now, node.id, DEPLOYMENT_STOP_ERROR_PREFIX, DEPLOYMENT_STOP_ERROR_PREFIX)
      .run();
    await env.DATABASE.prepare(
      `UPDATE nodes SET cleanup_backoff_until = ? WHERE id = ? AND user_id = ?
       AND status IN ('destroying', 'deleting', 'error')`
    )
      .bind(new Date(Date.now() + config.failureBackoffMs).toISOString(), node.id, node.userId)
      .run();
    const cleanup = await cleanupDeploymentNode(env, node.id, node.userId, {
      retryAfterMs: config.failureBackoffMs,
      requestTimeoutMs: Math.max(
        1,
        Math.min(config.stoppedHandoffRequestTimeoutMs, deadline - Date.now())
      ),
    });
    if (cleanup.nodeDeleted) result.deleted++;
    if (cleanup.warnings.length) result.failed++;
  }
  const db = drizzle(env.DATABASE, { schema });
  const legacy = await db
    .select()
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.nodeRole, 'deployment'),
        eq(schema.nodes.nodeClass, 'managed'),
        eq(schema.nodes.runtime, 'vm'),
        eq(schema.nodes.status, 'running'),
        isNull(schema.nodes.placementCredentialSource),
        isNull(schema.nodes.placementCredentialReference),
        or(isNull(schema.nodes.cleanupBackoffUntil), lte(schema.nodes.cleanupBackoffUntil, now))
      )
    )
    .limit(config.nodeSweepLimit);
  for (const node of legacy) {
    if (Date.now() >= deadline) break;
    await db
      .update(schema.nodes)
      .set({ cleanupBackoffUntil: new Date(Date.now() + config.failureBackoffMs).toISOString() })
      .where(and(eq(schema.nodes.id, node.id), eq(schema.nodes.status, 'running')));
    try {
      await recoverLegacyDeploymentBinding(
        env,
        node,
        AbortSignal.timeout(
          Math.max(1, Math.min(config.stoppedHandoffRequestTimeoutMs, deadline - Date.now()))
        )
      );
    } catch (error) {
      log.warn('deployment_node.legacy_binding_unavailable', {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
