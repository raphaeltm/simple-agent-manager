/** Deployment teardown keeps its placement until strict runtime termination succeeds. */
import { DEPLOYMENT_STOP_ERROR_PREFIX } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { retireDeletedDeploymentNodeRecord } from './node-resource-lifecycle';
import { deleteNodeResourcesStrict } from './strict-node-deletion';

export interface DeploymentNodeCleanupResult {
  nodeDeleted: boolean;
  warnings: string[];
}

/**
 * Claim only a managed deployment with no serving consumers. Keeping stopping
 * environments linked makes failed teardown visible and retryable. Admission
 * refuses destroying nodes, so the no-consumer test and claim are atomic.
 */
export async function cleanupDeploymentNode(
  env: Env,
  nodeId: string,
  userId: string,
  options: { retryAfterMs: number; requestTimeoutMs: number }
): Promise<DeploymentNodeCleanupResult> {
  const now = new Date().toISOString();
  const claim = await env.DATABASE.prepare(
    `UPDATE nodes SET status = CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'destroying' END, health_status = 'stale', updated_at = ?
     WHERE id = ? AND user_id = ?
       AND node_role = 'deployment' AND node_class = 'managed' AND runtime = 'vm'
       AND (status != 'deleted' OR runtime_termination_confirmed_at IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM deployment_environments de WHERE de.node_id = nodes.id
           AND de.status != 'stopping'
       )
     RETURNING status, runtime_termination_confirmed_at AS runtimeTerminationConfirmedAt,
               provider_instance_id AS providerInstanceId,
               runtime_incarnation_id AS runtimeIncarnationId`
  )
    .bind(now, nodeId, userId)
    .first<{
      status: string;
      runtimeTerminationConfirmedAt: string | null;
      providerInstanceId: string | null;
      runtimeIncarnationId: string | null;
    }>();
  if (!claim) return { nodeDeleted: false, warnings: [] };

  try {
    const proof =
      claim.status === 'deleted'
        ? claim
        : await deleteNodeResourcesStrict(nodeId, userId, env, {
            expectedRuntime: { userId, runtime: 'vm', ...claim },
            providerRequestContext: { signal: AbortSignal.timeout(options.requestTimeoutMs) },
            requestDeadlineMs: Date.now() + options.requestTimeoutMs,
          });
    await retireDeletedDeploymentNodeRecord(
      drizzle(env.DATABASE, { schema }),
      env,
      nodeId,
      userId,
      proof
    );
    return { nodeDeleted: true, warnings: [] };
  } catch (error) {
    const message = `${DEPLOYMENT_STOP_ERROR_PREFIX} during managed node teardown: ${error instanceof Error ? error.message : String(error)}`;
    // Do not reset destroying to error: that would reopen admission. Exact
    // incarnation fences prevent an old failure from poisoning a replacement.
    await env.DATABASE.prepare(
      `UPDATE nodes SET error_message = ?, cleanup_backoff_until = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'destroying'
         AND provider_instance_id IS ? AND runtime_incarnation_id IS ?`
    )
      .bind(
        message,
        new Date(Date.now() + options.retryAfterMs).toISOString(),
        now,
        nodeId,
        userId,
        claim.providerInstanceId,
        claim.runtimeIncarnationId
      )
      .run();
    await env.DATABASE.prepare(
      `UPDATE deployment_environments SET status = 'error', observed_status = 'failed',
         observed_error_message = ?, updated_at = ?
       WHERE node_id = ? AND status = 'stopping'
         AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = ? AND n.user_id = ?
           AND n.status = 'destroying' AND n.provider_instance_id IS ?
           AND n.runtime_incarnation_id IS ?)`
    )
      .bind(
        message,
        now,
        nodeId,
        nodeId,
        userId,
        claim.providerInstanceId,
        claim.runtimeIncarnationId
      )
      .run();
    return { nodeDeleted: false, warnings: [message] };
  }
}
