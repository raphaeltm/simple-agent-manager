/** Deployment teardown keeps its placement until strict runtime termination succeeds. */
import { DEPLOYMENT_STOP_ERROR_PREFIX } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { deleteDNSRecord } from './dns';
import { getTimeoutMs } from './fetch-timeout';
import {
  DEFAULT_NODE_DECISION_DEDUPE_WINDOW_MS,
  recordNodeLifecycleDecision,
} from './node-lifecycle-decisions';
import { retireDeletedDeploymentNodeRecord } from './node-resource-lifecycle';
import { deleteNodeResourcesStrict } from './strict-node-deletion';

/** Keeps the recorded cause readable in the node UI; the full text stays in `error_message`. */
const CLEANUP_BLOCKED_REASON_MAX_LENGTH = 500;

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
               runtime_incarnation_id AS runtimeIncarnationId, backend_dns_record_id AS backendDnsRecordId`
  )
    .bind(now, nodeId, userId)
    .first<{
      status: string;
      runtimeTerminationConfirmedAt: string | null;
      providerInstanceId: string | null;
      runtimeIncarnationId: string | null;
      backendDnsRecordId: string | null;
    }>();
  if (!claim) return { nodeDeleted: false, warnings: [] };

  // The blocked clock survives retries, so the stranded-node sweep's alert deadline and the
  // recorded reason are not erased by the next attempt; `retireDeletedDeploymentNodeRecord`
  // clears them with the terminal proof.
  try {
    const signal = AbortSignal.timeout(options.requestTimeoutMs);
    const deadline = Date.now() + options.requestTimeoutMs;
    const proof =
      claim.status === 'deleted'
        ? claim
        : await deleteNodeResourcesStrict(nodeId, userId, env, {
            expectedRuntime: { userId, runtime: 'vm', ...claim },
            cleanupDns: false,
            providerRequestContext: { signal },
            requestDeadlineMs: deadline,
          });
    // DNS is retryable cleanup too. Strict deletion's default DNS adapter is
    // best-effort, so retain the record/link rather than losing its ID on failure.
    if (claim.backendDnsRecordId) {
      await deleteDNSRecord(
        claim.backendDnsRecordId,
        {
          ...env,
          CF_API_TIMEOUT_MS: String(
            Math.max(1, Math.min(getTimeoutMs(env.CF_API_TIMEOUT_MS), deadline - Date.now()))
          ),
        },
        signal
      );
    }
    await retireDeletedDeploymentNodeRecord(
      drizzle(env.DATABASE, { schema }),
      env,
      nodeId,
      userId,
      proof
    );
    await recordNodeLifecycleDecision(env.DATABASE, {
      nodeId,
      source: 'deployment_teardown',
      decision: 'destroyed',
      reason: 'strict_termination_proof',
    });
    return { nodeDeleted: true, warnings: [] };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = `${DEPLOYMENT_STOP_ERROR_PREFIX} during managed node teardown: ${cause}`;
    // Do not reset destroying to error: that would reopen admission. Exact
    // incarnation fences prevent an old failure from poisoning a replacement.
    // The reason also goes to `cleanup_blocked_reason`, which the node UI and
    // `ops_why_is_node_alive` read; `error_message` alone was cleared on deletion.
    await env.DATABASE.prepare(
      `UPDATE nodes SET error_message = ?, cleanup_backoff_until = ?, updated_at = ?,
         cleanup_blocked_since = COALESCE(cleanup_blocked_since, ?), cleanup_blocked_reason = ?
       WHERE id = ? AND user_id = ? AND status = 'destroying'
         AND provider_instance_id IS ? AND runtime_incarnation_id IS ?`
    )
      .bind(
        message,
        new Date(Date.now() + options.retryAfterMs).toISOString(),
        now,
        now,
        cause.slice(0, CLEANUP_BLOCKED_REASON_MAX_LENGTH),
        nodeId,
        userId,
        claim.providerInstanceId,
        claim.runtimeIncarnationId
      )
      .run();
    await recordNodeLifecycleDecision(env.DATABASE, {
      nodeId,
      source: 'deployment_teardown',
      decision: 'destroy_failed',
      reason: cause,
      dedupeWindowMs: DEFAULT_NODE_DECISION_DEDUPE_WINDOW_MS,
    });
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
