import type { Env } from '../env';
import { ensureTaskRunnerStarted } from './task-runner-do';
import { getWebhookTriggerLimits } from './webhook-trigger-config';
import { finishWebhookDelivery } from './webhook-trigger-store';

interface StaleWebhookDelivery {
  id: string;
  triggerId: string;
  executionId: string | null;
  processingToken: string;
  processingHeartbeatAt: string;
  taskId: string | null;
  taskStatus: string | null;
}

async function failStaleWebhookDelivery(
  env: Env,
  delivery: StaleWebhookDelivery,
  now: string
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_deliveries
          SET outcome = 'internal_error', http_status = 503, error_code = 'submission_failed',
              processed_at = ?, processing_token = NULL, processing_heartbeat_at = NULL
        WHERE id = ? AND trigger_id = ? AND outcome = 'processing'
          AND processing_token = ? AND processing_heartbeat_at = ?`
  )
    .bind(
      now,
      delivery.id,
      delivery.triggerId,
      delivery.processingToken,
      delivery.processingHeartbeatAt
    )
    .run();
  return Boolean(result.meta.changes);
}

async function hasStartedTaskRunner(env: Env, delivery: StaleWebhookDelivery): Promise<boolean> {
  if (!delivery.taskId) return false;
  return ensureTaskRunnerStarted(env, delivery.taskId);
}

async function acceptDurableDelivery(env: Env, delivery: StaleWebhookDelivery): Promise<boolean> {
  if (!delivery.executionId) return false;
  try {
    await finishWebhookDelivery(env, {
      id: delivery.id,
      triggerId: delivery.triggerId,
      outcome: 'accepted',
      httpStatus: 202,
      processingToken: delivery.processingToken,
      executionId: delivery.executionId,
    });
    return true;
  } catch {
    return false;
  }
}

/** Repairs stale processing audits after worker interruption or post-submit finalization failure. */
export async function reconcileStaleWebhookDeliveries(env: Env): Promise<number> {
  const limits = getWebhookTriggerLimits(env);
  const cutoff = new Date(Date.now() - limits.deliveryProcessingLeaseSeconds * 1000).toISOString();
  const rows = await env.DATABASE.prepare(
    `SELECT d.id, d.trigger_id AS triggerId, d.execution_id AS executionId,
            d.processing_token AS processingToken,
            d.processing_heartbeat_at AS processingHeartbeatAt,
            t.id AS taskId, t.status AS taskStatus
       FROM webhook_deliveries d
       LEFT JOIN tasks t ON t.trigger_execution_id = d.execution_id
      WHERE d.outcome = 'processing' AND d.processing_token IS NOT NULL
        AND d.processing_heartbeat_at < ?
      ORDER BY d.processing_heartbeat_at, d.id
      LIMIT ?`
  )
    .bind(cutoff, limits.deliveryCleanupBatchSize)
    .all<StaleWebhookDelivery>();

  let reconciled = 0;
  for (const delivery of rows.results) {
    const taskAdvanced =
      delivery.taskStatus !== null &&
      ['delegated', 'in_progress', 'completed'].includes(delivery.taskStatus);
    let taskRunnerStarted = false;
    try {
      taskRunnerStarted = await hasStartedTaskRunner(env, delivery);
    } catch {
      continue;
    }

    const repaired =
      taskAdvanced || taskRunnerStarted
        ? await acceptDurableDelivery(env, delivery)
        : await failStaleWebhookDelivery(env, delivery, new Date().toISOString());
    if (repaired) reconciled += 1;
  }
  return reconciled;
}
