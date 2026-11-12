/**
 * Draining the durable trigger queue (see github-trigger-queue.ts for how events enter it and
 * how one is started). The operations cron calls `drainTriggerQueue`; a committed webhook event
 * calls `drainTriggerQueueForTrigger` so a free slot is used without waiting for the next tick.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { processQueuedTriggerExecution } from './github-trigger-queue';
import { githubTriggerRecoveryConfig } from './github-trigger-recovery-config';
import type { TriggerTaskSubmitter } from './trigger-admission';
import { repairWebhookQueueRecords, type WebhookQueueRepairCounts } from './webhook-signed-store';
import { WEBHOOK_QUEUE_ROW_SQL } from './webhook-trigger-queue';

export interface TriggerQueueDrainOptions {
  /** False while GitHub triggers are not configured: their waiting events stay put. */
  includeGitHub: boolean;
  /** False while webhook triggers are switched off. */
  includeWebhooks: boolean;
}

// Each source is named by its own marker. A row that is neither is left alone rather than
// swept in with one of them.
const QUEUE_SOURCE_SQL = `((? = 1 AND github_delivery_id IS NOT NULL) OR (? = 1 AND (${WEBHOOK_QUEUE_ROW_SQL})))`;

/**
 * Rows worth trying this tick. A waiting event can only be promoted when it is first in its
 * automation's line, so later ones are not selected: they would each cost several writes to be
 * told to keep waiting, and would crowd the head out of a bounded batch. Events with a subject
 * (GitHub) are still tried anywhere in the line, because they can join that subject's live run.
 */
const QUEUE_CANDIDATE_SQL = `(q.status IN ('routing','queued') OR q.subject_key IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM trigger_executions older
    WHERE older.trigger_id = q.trigger_id AND older.status = 'waiting'
      AND older.queue_expires_at > ? AND older.sequence_number < q.sequence_number))`;

function queueSourceBindings(options: TriggerQueueDrainOptions): number[] {
  return [options.includeGitHub ? 1 : 0, options.includeWebhooks ? 1 : 0];
}

/**
 * The events expiry drops this tick, oldest deadline first. Both statements in the expiry batch
 * read this same selection, so the GitHub call records changed are exactly those of the dropped
 * events, found through idx_trigger_queue_expiry rather than a scan of every dropped row.
 */
const EXPIRING_SQL = `SELECT id FROM trigger_executions
  WHERE status IN ('waiting','queued') AND queue_expires_at<=?
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.trigger_execution_id=trigger_executions.id)
  ORDER BY queue_expires_at, id LIMIT ?`;

/**
 * Bounded serial recovery on the existing operations cadence; waiting does not consume retries.
 * Expiry runs for every source regardless of the options, so a switched-off source still gives
 * its waiting events a way out. A dropped webhook event's prompt is cleared: it is the only copy
 * of the event's content and has no further use.
 *
 * Three isolated steps, each of which can fail without stopping the others:
 * 1. Expiry and the GitHub call records it changes, in one transaction.
 * 2. The webhook repair (repairWebhookQueueRecords): settles the call records of dropped and
 *    started webhook events, including the ones step 1 just dropped, and finishes whatever an
 *    earlier start left half recorded. It settles at most one batch per tick; past that, and
 *    when it fails, the rest is settled on a later tick.
 * 3. Starting the events at the head of each line.
 */
export async function drainTriggerQueue(
  env: Env,
  submitter?: TriggerTaskSubmitter,
  options: TriggerQueueDrainOptions = { includeGitHub: true, includeWebhooks: true }
) {
  const config = githubTriggerRecoveryConfig(env);
  const now = new Date().toISOString();
  let expiredWebhookEvents = 0;
  try {
    const [, expired] = await env.DATABASE.batch<{ isWebhook: number }>([
      // Before the expiry, so the selection still sees the rows as waiting.
      env.DATABASE.prepare(
        `UPDATE github_webhook_deliveries SET decision='dropped',decision_reason='queue_expired'
        WHERE id IN (SELECT github_delivery_id || ':' || trigger_id FROM trigger_executions
          WHERE id IN (${EXPIRING_SQL}) AND github_delivery_id IS NOT NULL)`
      ).bind(now, config.batchSize),
      // RETURNING names exactly the rows this statement dropped.
      env.DATABASE.prepare(
        `UPDATE trigger_executions SET status='dropped',skip_reason='queue_expired',completed_at=?,
          rendered_prompt=CASE WHEN (${WEBHOOK_QUEUE_ROW_SQL}) THEN NULL ELSE rendered_prompt END
        WHERE id IN (${EXPIRING_SQL})
        RETURNING id, (${WEBHOOK_QUEUE_ROW_SQL}) AS isWebhook`
      ).bind(now, now, config.batchSize),
    ]);
    expiredWebhookEvents = (expired?.results ?? []).filter((row) => row.isWebhook).length;
  } catch (error) {
    // Nothing of it was committed, so the next tick retries it. Starting waiting events below
    // does not depend on it: an expired event is never promoted or counted as waiting.
    log.error('trigger_queue.expiry_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let repaired: WebhookQueueRepairCounts | null = null;
  try {
    repaired = await repairWebhookQueueRecords(env, config.batchSize, now);
  } catch (error) {
    // Idempotent: the next tick repeats it.
    log.error('trigger_queue.webhook_repair_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const rows = await env.DATABASE.prepare(
    `SELECT q.id, q.trigger_id AS triggerId, q.status, q.subject_key IS NULL AS subjectless
    FROM trigger_executions q WHERE q.queue_expires_at IS NOT NULL AND q.rendered_prompt IS NOT NULL
    AND q.status IN ('waiting','routing','queued') AND (q.status <> 'waiting' OR q.queue_expires_at > ?)
    AND ${QUEUE_SOURCE_SQL} AND ${QUEUE_CANDIDATE_SQL}
    ORDER BY COALESCE(q.queue_attempted_at,q.created_at),q.sequence_number LIMIT ?`
  )
    .bind(now, ...queueSourceBindings(options), now, config.batchSize)
    .all<{ id: string; triggerId: string; status: string; subjectless: number }>();
  const deadline = Date.now() + config.maxWallTimeMs;
  // Every attempt counts against the tick's budget, including one that throws, so failing
  // starts cannot stretch a tick past `batchSize` attempts.
  let processed = 0;
  for (const row of rows.results) {
    if (Date.now() >= deadline || processed >= config.batchSize) break;
    processed += 1;
    try {
      const result = await processQueuedTriggerExecution(env, row.id, submitter);
      // Only the head of each line was selected. When it starts, the next event may fit a
      // further free run slot of the same automation, so keep filling that line now instead of
      // one event per tick. Subject events are already tried anywhere in their line.
      if (row.status === 'waiting' && row.subjectless && result.outcome === 'submitted') {
        processed += await drainTriggerQueueForTrigger(
          env,
          row.triggerId,
          config.batchSize - processed,
          submitter,
          deadline
        );
      }
    } catch {
      log.warn('trigger_queue.retry', { executionId: row.id });
    }
  }
  return {
    expiredWebhookEvents,
    repaired,
    selected: rows.results.length,
    processed,
  };
}

/**
 * Tries the events at the head of one automation's line, oldest first, until one cannot start.
 * Called after a webhook event is committed so a free slot is used at once instead of at the
 * next cron tick, and by the cron drain after a head starts, to fill the automation's other free
 * slots. Returns how many events it tried, including one that threw.
 */
export async function drainTriggerQueueForTrigger(
  env: Env,
  triggerId: string,
  limit: number,
  submitter?: TriggerTaskSubmitter,
  deadline = Number.POSITIVE_INFINITY
): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await env.DATABASE.prepare(
    `SELECT id FROM trigger_executions WHERE trigger_id=? AND status='waiting' AND queue_expires_at>?
      AND rendered_prompt IS NOT NULL ORDER BY sequence_number LIMIT ?`
  )
    .bind(triggerId, new Date().toISOString(), limit)
    .all<{ id: string }>();
  let attempted = 0;
  for (const row of rows.results) {
    if (Date.now() >= deadline) break;
    attempted += 1;
    try {
      const result = await processQueuedTriggerExecution(env, row.id, submitter);
      // Later events are behind this one in line; if it could not start, neither can they.
      if (result.outcome !== 'submitted') break;
    } catch {
      log.warn('trigger_queue.retry', { executionId: row.id, triggerId });
      break;
    }
  }
  return attempted;
}
