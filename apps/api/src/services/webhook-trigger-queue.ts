/**
 * Durable intake for signed webhook events. A verified event becomes a waiting
 * `trigger_executions` row in the same queue GitHub events use (github-trigger-queue.ts), and
 * the sender is answered only after that row is committed.
 *
 * SAM keeps no raw request body, so the rendered prompt is the only copy of the event. It is
 * written in the same statement that creates the waiting row: once this returns `queued`, the
 * event survives a dropped connection or a restarted worker, and the cron drain starts it.
 */
import type * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getWebhookTriggerLimits } from './webhook-trigger-config';

export interface WebhookQueueAcceptInput {
  trigger: schema.TriggerRow;
  /** The call's reservation in `webhook_deliveries`; the accept applies only while it is held. */
  delivery: { id: string; processingToken: string };
  receivedAt: string;
  /** Most live waiting events this automation may hold. */
  maxPending: number;
  /** Seconds the event may wait for a free run. */
  ttlSeconds: number;
  renderPrompt: (executionId: string, sequenceNumber: number) => string;
}

export type WebhookQueueAcceptResult =
  | { outcome: 'queued'; executionId: string; sequenceNumber: number; queueExpiresAt: string }
  /** The waiting line is at its limit. Nothing was recorded against the event ID. */
  | { outcome: 'queue_full' }
  | { outcome: 'inactive'; reason: 'paused' | 'disabled' }
  /** Another request took over the call's reservation; the sender should retry. */
  | { outcome: 'unavailable'; reason: 'lease_lost' };

/** `trigger_executions.event_type` for a queued webhook event. */
export const WEBHOOK_QUEUE_EVENT_TYPE = 'webhook';
/**
 * Marks a queue row as a webhook event. The queue is shared with GitHub events, and only webhook
 * rows have their prompt cleared (it is the sole copy of the event) and follow the webhook
 * switch, so every statement that treats them differently uses this one predicate.
 *
 * `event_type` alone is not enough: token (`sam_bearer`) webhook runs are admitted inline with
 * the same event type and keep their rendered prompt as run history. Only queued rows have a
 * queue deadline, so both terms are required; without the second, the cron repair would clear
 * every token webhook run's prompt.
 */
export const WEBHOOK_QUEUE_ROW_SQL = `event_type = '${WEBHOOK_QUEUE_EVENT_TYPE}' AND queue_expires_at IS NOT NULL`;

const LIVE_WAITING_COUNT_SQL = `(SELECT COUNT(*) FROM trigger_executions e
  WHERE e.trigger_id = triggers.id AND e.status = 'waiting' AND e.queue_expires_at > ?)`;

export async function acceptWebhookTriggerExecution(
  env: Env,
  input: WebhookQueueAcceptInput
): Promise<WebhookQueueAcceptResult> {
  const { trigger, delivery } = input;
  const executionId = ulid();
  const now = new Date().toISOString();
  const queueExpiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();

  // The prompt needs the event's sequence number, so the number is taken first, in one
  // statement that any number of concurrent requests can run without colliding. It is taken
  // only while the automation is active and its line has room. If the insert below then
  // fails (the reservation was lost in between), the number is skipped; nothing depends on
  // sequence numbers being consecutive, only on their order.
  //
  // Ordering contract. Waiting events start in sequence order, and an event that is still
  // being accepted holds nobody up: promotion only looks at committed rows. So when two calls
  // are in flight together, the one that took the lower number but commits second can start
  // after the other one, and is then first in line for the next free slot. Calls that arrive
  // one after another (the next is sent after the previous was answered) always start in
  // arrival order. Concurrent calls have no order to keep: neither Slack nor an HMAC sender
  // waits for one call to be answered before sending the next. Holding the line for an
  // uncommitted number would instead let a request that dies mid-accept block every later event
  // until expiry, and retrying the number under contention would turn a burst into 503s that a
  // sender like GitHub never retries. Proven in signed-webhook-ingress.test.ts ("ordering").
  const taken = await env.DATABASE.prepare(
    `UPDATE triggers SET next_execution_sequence = next_execution_sequence + 1
      WHERE id = ? AND project_id = ? AND status = 'active' AND ${LIVE_WAITING_COUNT_SQL} < ?
      RETURNING next_execution_sequence - 1 AS sequenceNumber`
  )
    .bind(trigger.id, trigger.projectId, now, input.maxPending)
    .first<{ sequenceNumber: number }>();
  if (!taken) return (await refusal(env, input, now)) ?? { outcome: 'queue_full' };
  const sequenceNumber = taken.sequenceNumber;

  // One transaction: the waiting row (with its prompt) and the call record's move to `queued`.
  // The insert repeats every condition it depends on: the automation is active, the line has
  // room, and this request still holds the call's reservation.
  const [inserted] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO trigger_executions
        (id, trigger_id, project_id, status, event_type, scheduled_at, sequence_number,
         created_at, admission_snapshot_json, rendered_prompt, queue_expires_at)
       SELECT ?, id, project_id, 'waiting', '${WEBHOOK_QUEUE_EVENT_TYPE}', ?, ?, ?, ?, ?, ?
         FROM triggers
        WHERE id = ? AND project_id = ? AND status = 'active'
          AND ${LIVE_WAITING_COUNT_SQL} < ?
          AND EXISTS (SELECT 1 FROM webhook_deliveries d
                       WHERE d.id = ? AND d.trigger_id = triggers.id
                         AND d.outcome = 'processing' AND d.processing_token = ?)`
    ).bind(
      executionId,
      input.receivedAt,
      sequenceNumber,
      now,
      JSON.stringify(trigger),
      input.renderPrompt(executionId, sequenceNumber),
      queueExpiresAt,
      trigger.id,
      trigger.projectId,
      now,
      input.maxPending,
      delivery.id,
      delivery.processingToken
    ),
    env.DATABASE.prepare(
      `UPDATE webhook_deliveries
          SET outcome = 'queued', http_status = 202, execution_id = ?, processed_at = ?,
              processing_token = NULL, processing_heartbeat_at = NULL,
              expires_at = MAX(expires_at, ?)
        WHERE id = ? AND trigger_id = ? AND outcome = 'processing' AND processing_token = ?
          AND EXISTS (SELECT 1 FROM trigger_executions WHERE id = ?)`
    ).bind(
      executionId,
      now,
      // The call record is also the event ID's duplicate check. It must outlive the wait, or
      // the sender's replay of an event still waiting could be taken as new and run twice.
      new Date(
        Date.parse(queueExpiresAt) + getWebhookTriggerLimits(env).deliveryRetentionDays * 86_400_000
      ).toISOString(),
      delivery.id,
      trigger.id,
      delivery.processingToken,
      executionId
    ),
  ]);
  if (inserted?.meta.changes) {
    return { outcome: 'queued', executionId, sequenceNumber, queueExpiresAt };
  }
  return (await refusal(env, input, now)) ?? { outcome: 'unavailable', reason: 'lease_lost' };
}

/** Why the automation would not take the event, or null when the automation itself would. */
async function refusal(
  env: Env,
  input: WebhookQueueAcceptInput,
  now: string
): Promise<WebhookQueueAcceptResult | null> {
  const state = await env.DATABASE.prepare(
    `SELECT status, ${LIVE_WAITING_COUNT_SQL} AS pending
       FROM triggers WHERE id = ? AND project_id = ?`
  )
    .bind(now, input.trigger.id, input.trigger.projectId)
    .first<{ status: string; pending: number }>();
  if (!state || state.status === 'disabled') return { outcome: 'inactive', reason: 'disabled' };
  if (state.status !== 'active') return { outcome: 'inactive', reason: 'paused' };
  if (state.pending >= input.maxPending) return { outcome: 'queue_full' };
  return null;
}
