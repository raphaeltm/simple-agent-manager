/**
 * Storage for signed webhook automations: looking one up by the ID in its address, saving and
 * reading its signing secret, recording refused calls, and keeping a call's record in step with
 * the queued run it started.
 */
import {
  isWebhookSignedScheme,
  WEBHOOK_SIGNING_SECRET_MAX_LENGTH,
  WEBHOOK_SIGNING_SECRET_MIN_LENGTH,
  type WebhookDeliveryOutcome,
  type WebhookEventIdLocation,
  type WebhookSignedVerificationScheme,
  type WebhookSigningSecretStatus,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { startsWithCredentialToken } from '../lib/credential-token-redaction';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt, encrypt } from './encryption';
import { getWebhookTriggerLimits } from './webhook-trigger-config';
import {
  toWebhookRuntimeConfig,
  webhookRowEventId,
  webhookRowScheme,
  type WebhookRuntimeConfig,
} from './webhook-trigger-config-rows';
import { WEBHOOK_TOKEN_PREFIX } from './webhook-trigger-crypto';
import { WEBHOOK_QUEUE_ROW_SQL } from './webhook-trigger-queue';

export interface ResolvedSignedWebhookTrigger {
  trigger: schema.TriggerRow;
  projectName: string;
  config: WebhookRuntimeConfig;
  scheme: WebhookSignedVerificationScheme;
  signatureHeader: string | null;
  eventId: WebhookEventIdLocation | null;
  /** Ciphertext and nonce; null until a person saves the secret. */
  encryptedSecret: { ciphertext: string; iv: string } | null;
}

/** Resolves the automation named in a signed address. Bearer automations are never returned. */
export async function findSignedWebhookTrigger(
  env: Env,
  triggerId: string
): Promise<ResolvedSignedWebhookTrigger | null> {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      trigger: schema.triggers,
      projectName: schema.projects.name,
      config: schema.webhookTriggerConfigs,
    })
    .from(schema.webhookTriggerConfigs)
    .innerJoin(schema.triggers, eq(schema.webhookTriggerConfigs.triggerId, schema.triggers.id))
    .innerJoin(schema.projects, eq(schema.triggers.projectId, schema.projects.id))
    .where(eq(schema.webhookTriggerConfigs.triggerId, triggerId))
    .get();
  if (!row || row.trigger.sourceType !== 'webhook') return null;
  const scheme = webhookRowScheme(row.config);
  if (!isWebhookSignedScheme(scheme)) return null;
  return {
    trigger: row.trigger,
    projectName: row.projectName,
    config: toWebhookRuntimeConfig(row.config),
    scheme,
    signatureHeader: row.config.signatureHeader,
    eventId: webhookRowEventId(row.config),
    encryptedSecret:
      row.config.signingSecretEncrypted && row.config.signingSecretIv
        ? { ciphertext: row.config.signingSecretEncrypted, iv: row.config.signingSecretIv }
        : null,
  };
}

export function decryptWebhookSigningSecret(
  env: Env,
  encrypted: { ciphertext: string; iv: string }
): Promise<string> {
  return decrypt(encrypted.ciphertext, encrypted.iv, getCredentialEncryptionKey(env));
}

// First match wins, so the SAM webhook token is named before the generic credential shapes.
const WRONG_SECRET_KINDS: Array<{ matches: (secret: string) => boolean; message: string }> = [
  {
    matches: (secret) => /^(xox[a-z]-|xapp-)/i.test(secret),
    message:
      "That looks like a Slack token. Paste the app's Signing Secret from Basic Information, App Credentials.",
  },
  {
    matches: (secret) => secret.startsWith(WEBHOOK_TOKEN_PREFIX),
    message: 'That is a SAM webhook token, not the sender’s signing secret.',
  },
  {
    // GitHub, SAM and provider API tokens: the shapes every redactor shares.
    matches: startsWithCredentialToken,
    message: 'That looks like an access token or API key, not the webhook’s secret.',
  },
  {
    matches: (secret) => /^https?:\/\//i.test(secret),
    message: 'That is a URL, not a signing secret.',
  },
];

/**
 * Checks a pasted signing secret. Messages are fixed strings: the value is never echoed, logged
 * or included in an error.
 *
 * The secret is kept exactly as given: it is an HMAC key, so its bytes are the key, and a sender
 * whose secret starts or ends with whitespace must still verify. The checks read a trimmed view,
 * so padding cannot make an empty value pass, or let a pasted access token or URL through.
 */
export function validateWebhookSigningSecret(
  value: unknown
): { ok: true; secret: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: 'secret must be a string' };
  const visible = value.trim();
  if (visible.length < WEBHOOK_SIGNING_SECRET_MIN_LENGTH)
    return {
      ok: false,
      message: `The signing secret must be at least ${WEBHOOK_SIGNING_SECRET_MIN_LENGTH} characters`,
    };
  if (value.length > WEBHOOK_SIGNING_SECRET_MAX_LENGTH)
    return {
      ok: false,
      message: `The signing secret must be at most ${WEBHOOK_SIGNING_SECRET_MAX_LENGTH} characters`,
    };
  const wrong = WRONG_SECRET_KINDS.find((kind) => kind.matches(visible));
  return wrong ? { ok: false, message: wrong.message } : { ok: true, secret: value };
}

/**
 * Replaces the signing secret in place. The project and signed-scheme checks are part of the
 * write, so a trigger ID from another project, or a bearer automation, changes nothing.
 */
export async function setWebhookSigningSecret(
  env: Env,
  input: { projectId: string; triggerId: string; userId: string; secret: string }
): Promise<WebhookSigningSecretStatus | null> {
  const encrypted = await encrypt(input.secret, getCredentialEncryptionKey(env));
  const setAt = new Date().toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_trigger_configs
        SET signing_secret_encrypted = ?, signing_secret_iv = ?, signing_secret_set_at = ?,
            signing_secret_set_by = ?, updated_at = ?
      WHERE trigger_id = ? AND verification_scheme IN ('slack_v0', 'hmac_sha256_body')
        AND EXISTS (SELECT 1 FROM triggers
                     WHERE id = ? AND project_id = ? AND source_type = 'webhook')`
  )
    .bind(
      encrypted.ciphertext,
      encrypted.iv,
      setAt,
      input.userId,
      setAt,
      input.triggerId,
      input.triggerId,
      input.projectId
    )
    .run();
  return result.meta.changes ? { set: true, setAt, setBy: input.userId } : null;
}

/** How often one isolate re-records the same refusal. The status line lags by at most this. */
const NOTICE_WRITE_MIN_INTERVAL_MS = 5_000;
/** Bound on the per-isolate memo; the oldest entries go first. */
const NOTICE_WRITE_MEMO_MAX = 500;
const recentNoticeWrites = new Map<string, number>();

function rememberNoticeWrite(id: string, at: number): void {
  recentNoticeWrites.delete(id);
  recentNoticeWrites.set(id, at);
  while (recentNoticeWrites.size > NOTICE_WRITE_MEMO_MAX) {
    const oldest = recentNoticeWrites.keys().next().value;
    if (oldest === undefined) break;
    recentNoticeWrites.delete(oldest);
  }
}

/**
 * Records a call SAM answered without treating it as an event: a refusal, or the provider
 * checking the address. One row per automation, outcome, reason and rate-limit window, so a
 * flood of forged calls cannot grow the table. Returns the row ID and whether this call created
 * it, which is what bounds the matching project event to one per window.
 */
export async function recordWebhookSignedNotice(
  env: Env,
  input: {
    triggerId: string;
    outcome: Extract<WebhookDeliveryOutcome, 'rejected' | 'challenge' | 'queue_full'>;
    reason: string;
    httpStatus: number;
    bodyBytes: number;
    windowStart: number;
    receivedAt: string;
  }
): Promise<{ id: string; created: boolean }> {
  const limits = getWebhookTriggerLimits(env);
  const expiresAt = new Date(
    new Date(input.receivedAt).getTime() + limits.deliveryRetentionDays * 86_400_000
  ).toISOString();
  const id = `${input.outcome}:${input.triggerId}:${input.reason}:${input.windowStart}`;
  // Refusals can come from anyone who knows the address, so they must stay cheap: once this
  // isolate has recorded one, repeats inside a short interval touch nothing.
  const now = Date.now();
  const lastWrite = recentNoticeWrites.get(id);
  if (lastWrite !== undefined && now - lastWrite < NOTICE_WRITE_MIN_INTERVAL_MS) {
    return { id, created: false };
  }
  rememberNoticeWrite(id, now);
  const result = await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries
      (id, trigger_id, idempotency_key_hash, request_fingerprint, outcome, http_status,
       body_bytes, received_at, processed_at, expires_at, error_code)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.triggerId,
      input.outcome,
      input.outcome,
      input.httpStatus,
      input.bodyBytes,
      input.receivedAt,
      input.receivedAt,
      expiresAt,
      input.outcome === 'challenge' ? null : input.reason
    )
    .run();
  if (result.meta.changes) return { id, created: true };
  // A later refusal in the same window reuses the row but must still read as the most recent
  // call, or a refusal that follows an accepted event would leave the setup status on
  // "receiving". Only the time moves: the row count and the once-per-window event do not.
  await env.DATABASE.prepare(
    `UPDATE webhook_deliveries SET received_at = ?, processed_at = ?, body_bytes = ?
      WHERE id = ? AND trigger_id = ? AND received_at < ?`
  )
    .bind(
      input.receivedAt,
      input.receivedAt,
      input.bodyBytes,
      id,
      input.triggerId,
      input.receivedAt
    )
    .run();
  return { id, created: false };
}

// A queued call's record follows its run once that run is settled: started (its task is
// recorded) or dropped. The new outcome is read from the execution inside the write, so an older
// caller cannot overwrite newer state, and only a record still marked `queued` changes.
const DELIVERY_FROM_EXECUTION_SET_SQL = `
       outcome = (SELECT CASE WHEN e.status = 'dropped' THEN 'dropped' ELSE 'accepted' END
                    FROM trigger_executions e WHERE e.id = webhook_deliveries.execution_id),
       error_code = (SELECT CASE WHEN e.status = 'dropped' THEN COALESCE(e.skip_reason, 'dropped') END
                       FROM trigger_executions e WHERE e.id = webhook_deliveries.execution_id),
       processed_at = ?`;
const EXECUTION_SETTLED_SQL = `EXISTS (SELECT 1 FROM trigger_executions e
  WHERE e.id = webhook_deliveries.execution_id AND (e.status = 'dropped' OR e.task_id IS NOT NULL))`;

// A webhook queue row still holding the event's prompt. Written exactly as the partial index
// idx_trigger_queue_webhook_prompts is, so the repair sweep reads that index, not the table.
const HELD_WEBHOOK_PROMPT_SQL = `${WEBHOOK_QUEUE_ROW_SQL} AND rendered_prompt IS NOT NULL`;
// The prompt is the only copy of the event while it waits. Once the run's task boundary is
// recorded the task and its chat hold it, and no retry reads the queue's copy again (a retry of
// a recorded submission returns the existing task). A dropped event has no further use for it.
// Rows without a recorded task keep it, so an interrupted start can still be retried.
const PROMPT_NO_LONGER_NEEDED_SQL = `status IN ('running', 'completed', 'failed', 'dropped')
  AND (status = 'dropped' OR (task_id IS NOT NULL AND submission_recorded_at IS NOT NULL))`;

/**
 * Brings one queued call's record in line with its run and removes the queue's copy of the
 * event once the run no longer needs it, in one transaction. Called right after a run starts;
 * {@link repairWebhookQueueRecords} redoes the same work from the cron when this call failed
 * or never ran.
 */
export async function settleWebhookQueueRecord(env: Env, executionId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE webhook_deliveries SET ${DELIVERY_FROM_EXECUTION_SET_SQL}
        WHERE execution_id = ? AND outcome = 'queued' AND ${EXECUTION_SETTLED_SQL}`
    ).bind(now, executionId),
    env.DATABASE.prepare(
      `UPDATE trigger_executions SET rendered_prompt = NULL
        WHERE id = ? AND ${HELD_WEBHOOK_PROMPT_SQL} AND ${PROMPT_NO_LONGER_NEEDED_SQL}`
    ).bind(executionId),
  ]);
}

export interface WebhookQueueRepairCounts {
  tasksLinked: number;
  callRecordsSynced: number;
  promptsCleared: number;
}

/**
 * Bounded, idempotent repair of webhook queue records, run on every cron drain. Anything the
 * per-run path left half done is finished here on the next tick: a run whose start was recorded
 * on its task but not on the execution, a call record still `queued` after its run started or
 * was dropped, and a prompt kept after its run no longer needs it. One transaction.
 *
 * Each statement touches at most `limit` rows and reads them through a partial index holding
 * only live queue rows (idx_trigger_queue_webhook_prompts, idx_webhook_deliveries_queued), so
 * the cost follows the live waiting lines and the records needing repair, not the size of the
 * execution table or the call log.
 */
export async function repairWebhookQueueRecords(
  env: Env,
  limit: number,
  now: string
): Promise<WebhookQueueRepairCounts> {
  // A run that started but whose start was never recorded on the execution. The admission
  // records it best effort, in one batch with the automation's run count and time, so a failed
  // write lost all three. The task itself usually is linked already (task submission writes
  // task_id), and otherwise names the execution, so the boundary is restored from it together
  // with the count and time, exactly once: rows are selected by submission_recorded_at IS NULL,
  // the count is taken first and the next statement sets it, so a later tick cannot count the
  // run again and the admission's own write (guarded by the same IS NULL) cannot either. Queued
  // rows are left to the drain: their start may still be in flight. ORDER BY makes both
  // statements pick the same rows.
  const unlinkedRuns = `SELECT id FROM trigger_executions
      WHERE ${HELD_WEBHOOK_PROMPT_SQL}
        AND status IN ('running', 'completed', 'failed') AND submission_recorded_at IS NULL
        AND EXISTS (SELECT 1 FROM tasks t
                     WHERE (t.id = trigger_executions.task_id
                            OR t.trigger_execution_id = trigger_executions.id)
                       AND t.project_id = trigger_executions.project_id)
      ORDER BY id LIMIT ?`;
  const startedOfUnlinked = `(SELECT MAX(e.started_at) FROM trigger_executions e
      WHERE e.trigger_id = triggers.id AND e.id IN (${unlinkedRuns}))`;
  const [, linked, synced, cleared] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE triggers
          SET trigger_count = trigger_count + (SELECT COUNT(*) FROM trigger_executions e
                WHERE e.trigger_id = triggers.id AND e.id IN (${unlinkedRuns})),
              last_triggered_at = CASE
                WHEN last_triggered_at IS NULL OR last_triggered_at < ${startedOfUnlinked}
                THEN ${startedOfUnlinked} ELSE last_triggered_at END,
              updated_at = ?
        WHERE id IN (SELECT trigger_id FROM trigger_executions WHERE id IN (${unlinkedRuns}))`
    ).bind(limit, limit, limit, now, limit),
    env.DATABASE.prepare(
      `UPDATE trigger_executions
          SET task_id = COALESCE(task_id, (SELECT t.id FROM tasks t
                          WHERE t.trigger_execution_id = trigger_executions.id
                            AND t.project_id = trigger_executions.project_id
                          ORDER BY t.created_at LIMIT 1)),
              submission_recorded_at = COALESCE(submission_recorded_at, ?)
        WHERE id IN (${unlinkedRuns})`
    ).bind(now, limit),
    env.DATABASE.prepare(
      `UPDATE webhook_deliveries SET ${DELIVERY_FROM_EXECUTION_SET_SQL}
        WHERE id IN (SELECT id FROM webhook_deliveries
                      WHERE outcome = 'queued' AND ${EXECUTION_SETTLED_SQL} LIMIT ?)`
    ).bind(now, limit),
    env.DATABASE.prepare(
      `UPDATE trigger_executions SET rendered_prompt = NULL
        WHERE id IN (SELECT id FROM trigger_executions
                      WHERE ${HELD_WEBHOOK_PROMPT_SQL} AND ${PROMPT_NO_LONGER_NEEDED_SQL} LIMIT ?)`
    ).bind(limit),
  ]);
  return {
    tasksLinked: linked?.meta.changes ?? 0,
    callRecordsSynced: synced?.meta.changes ?? 0,
    promptsCleared: cleared?.meta.changes ?? 0,
  };
}
