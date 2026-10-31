/** Resume durable stop intents through the same operation as the user endpoint. */
import { DEPLOYMENT_STOP_ERROR_PREFIX } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { stopDeploymentEnvironment } from '../routes/deployment-environment-lifecycle';
import { resolveCleanupConfig } from './node-cleanup/config';

export async function recoverInterruptedDeploymentStops(
  env: Env,
  waitUntil?: (work: Promise<unknown>) => void
): Promise<void> {
  const config = resolveCleanupConfig(env);
  const cutoff = new Date(Date.now() - config.orphanGracePeriodMs).toISOString();
  const rows = await env.DATABASE.prepare(
    `SELECT de.id, de.project_id AS projectId, n.user_id AS userId
     FROM deployment_environments de JOIN nodes n ON n.id = de.node_id
     WHERE n.node_role = 'deployment' AND n.node_class = 'managed' AND n.runtime = 'vm'
       AND n.status = 'running' AND de.updated_at <= ?
       AND (de.status = 'stopping' OR (de.status = 'error'
         AND substr(de.observed_error_message, 1, length(?)) = ?))
     ORDER BY de.updated_at, de.id LIMIT ?`
  )
    .bind(cutoff, DEPLOYMENT_STOP_ERROR_PREFIX, DEPLOYMENT_STOP_ERROR_PREFIX, config.nodeSweepLimit)
    .all<{ id: string; projectId: string; userId: string }>();
  if (!rows.results.length) return;
  const work = (async () => {
    const deadline = Date.now() + config.stoppedHandoffSweepBudgetMs;
    for (const row of rows.results) {
      if (Date.now() >= deadline) break;
      try {
        await stopDeploymentEnvironment({
          db: drizzle(env.DATABASE, { schema }),
          env: { ...env, NODE_AGENT_REQUEST_TIMEOUT_MS: String(config.agentTimeoutMs) },
          userId: row.userId,
          projectId: row.projectId,
          envId: row.id,
          executionCtx: { waitUntil: (promise) => waitUntil?.(promise) },
        });
      } catch (error) {
        log.warn('deployment_stop.recovery_pending', {
          environmentId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })();
  // Network I/O follows a persisted CAS stop claim and is out of the cron's
  // synchronous sweep path. Tests can await the same operation without a ctx.
  if (waitUntil) waitUntil(work);
  else await work;
}
