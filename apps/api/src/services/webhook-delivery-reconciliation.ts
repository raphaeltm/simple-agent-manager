import type { Env } from '../env';
import { getTaskRunnerStatus } from './task-runner-do';
import { getWebhookTriggerLimits } from './webhook-trigger-config';
import { finishWebhookDelivery } from './webhook-trigger-store';

interface StaleWebhookDelivery {
  id: string;
  triggerId: string;
  executionId: string | null;
  processingToken: string;
  taskId: string | null;
  taskStatus: string | null;
}

const STALE_LEASE_GUARD =
  `EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.id = ? AND d.trigger_id = ? ` +
  `AND d.outcome = 'processing' AND d.processing_token = ? ` +
  `AND d.processing_heartbeat_at < ?)`;

async function failStaleWebhookDelivery(
  env: Env,
  delivery: StaleWebhookDelivery,
  cutoff: string,
  now: string
): Promise<boolean> {
  const statements: D1PreparedStatement[] = [];
  if (delivery.taskId && delivery.executionId) {
    statements.push(
      env.DATABASE.prepare(
        `UPDATE tasks
            SET status = 'failed', error_message = 'Webhook delivery processing lease expired',
                completed_at = ?, updated_at = ?
          WHERE id = ? AND trigger_execution_id = ?
            AND status IN ('draft', 'ready', 'queued') AND ${STALE_LEASE_GUARD}`
      ).bind(
        now,
        now,
        delivery.taskId,
        delivery.executionId,
        delivery.id,
        delivery.triggerId,
        delivery.processingToken,
        cutoff
      )
    );
  }
  if (delivery.executionId) {
    statements.push(
      env.DATABASE.prepare(
        `UPDATE trigger_executions
            SET status = 'failed',
                error_message = COALESCE(error_message, 'Webhook delivery processing lease expired'),
                completed_at = COALESCE(completed_at, ?)
          WHERE id = ? AND trigger_id = ? AND status IN ('queued', 'running')
            AND ${STALE_LEASE_GUARD}`
      ).bind(
        now,
        delivery.executionId,
        delivery.triggerId,
        delivery.id,
        delivery.triggerId,
        delivery.processingToken,
        cutoff
      )
    );
  }
  statements.push(
    env.DATABASE.prepare(
      `UPDATE webhook_deliveries
          SET outcome = 'internal_error', http_status = 503, error_code = 'submission_failed',
              processed_at = ?, processing_token = NULL, processing_heartbeat_at = NULL
        WHERE id = ? AND trigger_id = ? AND outcome = 'processing'
          AND processing_token = ? AND processing_heartbeat_at < ?`
    ).bind(now, delivery.id, delivery.triggerId, delivery.processingToken, cutoff)
  );
  const results = await env.DATABASE.batch(statements);
  return Boolean(results.at(-1)?.meta.changes);
}

async function hasStartedTaskRunner(env: Env, delivery: StaleWebhookDelivery): Promise<boolean> {
  if (!delivery.taskId || delivery.taskStatus !== 'queued') return false;
  return Boolean(await getTaskRunnerStatus(env, delivery.taskId));
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
            d.processing_token AS processingToken, t.id AS taskId, t.status AS taskStatus
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
        : await failStaleWebhookDelivery(env, delivery, cutoff, new Date().toISOString());
    if (repaired) reconciled += 1;
  }
  return reconciled;
}
