import { GITHUB_TRIGGER_EVENT_TYPES } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parseJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { notifyFailedSweeps } from '../scheduled/failed-sweep-notifications';
import {
  handleGitHubEventForTriggers,
  type HandleGitHubEventInput,
} from './github-trigger-handler';
import { githubTriggerRecoveryConfig } from './github-trigger-recovery-config';
import { areGitHubTriggersConfigured } from './platform-config';

const SUPPORTED_EVENTS = new Set<string>(GITHUB_TRIGGER_EVENT_TYPES);
interface InboxRow {
  id: string;
  event_type: string;
  payload_json: string | null;
  attempts: number;
  created_at: string;
}

/** Called only after signature verification. A successful ACK means intake is durable. */
export async function persistGitHubTriggerIntake(
  env: Env,
  input: HandleGitHubEventInput
): Promise<boolean> {
  if (!SUPPORTED_EVENTS.has(input.eventType) || !(await areGitHubTriggersConfigured(env)))
    return false;
  const config = githubTriggerRecoveryConfig(env);
  const json = JSON.stringify(input.payload);
  if (new TextEncoder().encode(json).byteLength > config.payloadMaxBytes) {
    throw errors.badRequest('GitHub trigger payload exceeds durable intake limit');
  }
  const now = new Date().toISOString();
  // Existing pre-upgrade delivery IDs cannot be recovered without a stored payload.
  // Never resurrect them: they may already have executed consequential tasks.
  const result = await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO github_trigger_inbox
      (id, event_type, payload_json, state, available_at, created_at, expires_at)
     SELECT ?, ?, ?, 'pending', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM github_webhook_deliveries WHERE id = ?)
         OR EXISTS (SELECT 1 FROM github_trigger_inbox WHERE id = ?)`
  )
    .bind(
      input.deliveryId,
      input.eventType,
      json,
      now,
      now,
      new Date(Date.now() + config.dedupRetentionMs).toISOString(),
      input.deliveryId,
      input.deliveryId
    )
    .run();
  log.info('github_triggers.intake', {
    deliveryId: input.deliveryId,
    inserted: Boolean(result.meta.changes),
  });
  return true;
}

/** A lease bounds overlap; stable per-trigger execution identities fence consequential work. */
export async function recoverGitHubTriggerDelivery(env: Env, deliveryId: string): Promise<boolean> {
  if (!(await areGitHubTriggersConfigured(env))) return false;
  const config = githubTriggerRecoveryConfig(env);
  const now = new Date().toISOString();
  const token = ulid();
  const claim = await env.DATABASE.prepare(
    `UPDATE github_trigger_inbox SET state = 'processing', attempts = attempts + 1,
        lease_token = ?, lease_until = ?
     WHERE id = ? AND payload_json IS NOT NULL AND attempts < ?
       AND created_at > ?
       AND ((state = 'pending' AND available_at <= ?)
         OR (state = 'processing' AND lease_until <= ?))`
  )
    .bind(
      token,
      new Date(Date.now() + config.leaseMs).toISOString(),
      deliveryId,
      config.maxAttempts,
      new Date(Date.now() - config.payloadRetentionMs).toISOString(),
      now,
      now
    )
    .run();
  if (!claim.meta.changes) return false;
  const row = await env.DATABASE.prepare(
    'SELECT id, event_type, payload_json, attempts, created_at FROM github_trigger_inbox WHERE id = ? AND lease_token = ?'
  )
    .bind(deliveryId, token)
    .first<InboxRow>();
  if (!row?.payload_json) return false;
  try {
    // The audit is secondary; durable intake owns duplicate detection and retry.
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO github_webhook_deliveries (id, event_type, decision, decision_reason, created_at)
       VALUES (?, ?, 'processing', 'durable_intake', ?)`
    )
      .bind(row.id, row.event_type, row.created_at)
      .run();
    const routed = await handleGitHubEventForTriggers(
      env,
      {
        deliveryId: row.id,
        eventType: row.event_type,
        payload: parseJsonRecord(row.payload_json, 'github.trigger.intake'),
      },
      {
        scheduledAt: row.created_at,
        processingToken: token,
        beforeSubmit: async () => {
          const owner = await env.DATABASE.prepare(
            "SELECT id FROM github_trigger_inbox WHERE id = ? AND state = 'processing' AND lease_token = ? AND lease_until > ?"
          )
            .bind(row.id, token, new Date().toISOString())
            .first();
          if (!owner) throw new Error('GitHub intake lease lost');
        },
      }
    );
    if (routed.reason === 'feature_disabled')
      throw new Error('GitHub triggers disabled during recovery');
    const finished = await env.DATABASE.prepare(
      `UPDATE github_trigger_inbox SET state = 'completed', payload_json = NULL,
          lease_token = NULL, lease_until = NULL
       WHERE id = ? AND state = 'processing' AND lease_token = ?`
    )
      .bind(row.id, token)
      .run();
    log.info('github_triggers.recovered', {
      deliveryId: row.id,
      attempt: row.attempts,
      finalized: Boolean(finished.meta.changes),
    });
    return true;
  } catch {
    const exhausted = row.attempts >= config.maxAttempts;
    const delay = Math.min(
      config.retryMaxMs,
      config.retryBaseMs * 2 ** Math.min(row.attempts - 1, 30)
    );
    const retried = await env.DATABASE.prepare(
      `UPDATE github_trigger_inbox SET state = ?, available_at = ?,
          payload_json = CASE WHEN ? = 1 THEN NULL ELSE payload_json END,
          lease_token = NULL, lease_until = NULL
       WHERE id = ? AND state = 'processing' AND lease_token = ?`
    )
      .bind(
        exhausted ? 'exhausted' : 'pending',
        new Date(Date.now() + delay).toISOString(),
        exhausted ? 1 : 0,
        row.id,
        token
      )
      .run();
    if (exhausted && retried.meta.changes) await alertExhaustion(env);
    // Do not persist/log payloads or arbitrary exception strings from untrusted events.
    log.warn('github_triggers.recovery_retry', {
      deliveryId: row.id,
      attempt: row.attempts,
      exhausted,
      delayMs: delay,
    });
    return false;
  }
}

async function alertExhaustion(env: Env): Promise<void> {
  try {
    await notifyFailedSweeps(env, ['github_trigger_recovery_exhausted']);
  } catch {
    log.error('github_triggers.exhaustion_alert_failed', {});
  }
}

/** Existing operational cron supplies bounded automatic retries, expiry and retention. */
export async function runGitHubTriggerRecovery(
  env: Env,
  waitUntil?: (work: Promise<unknown>) => void
) {
  const config = githubTriggerRecoveryConfig(env);
  const now = new Date().toISOString();
  const expiry = await env.DATABASE.prepare(
    `UPDATE github_trigger_inbox SET state = 'exhausted', payload_json = NULL,
        lease_token = NULL, lease_until = NULL
     WHERE id IN (SELECT id FROM github_trigger_inbox
       WHERE state IN ('pending', 'processing')
         AND (created_at <= ? OR (attempts >= ? AND (lease_until IS NULL OR lease_until <= ?)))
       ORDER BY created_at LIMIT ?)`
  )
    .bind(
      new Date(Date.now() - config.payloadRetentionMs).toISOString(),
      config.maxAttempts,
      now,
      config.batchSize
    )
    .run();
  const due = await env.DATABASE.prepare(
    `SELECT id FROM github_trigger_inbox WHERE payload_json IS NOT NULL
       AND ((state = 'pending' AND available_at <= ?) OR (state = 'processing' AND lease_until <= ?))
     ORDER BY available_at LIMIT ?`
  )
    .bind(now, now, config.batchSize)
    .all<{ id: string }>();
  const purged = await env.DATABASE.prepare(
    `DELETE FROM github_trigger_inbox WHERE id IN (SELECT id FROM github_trigger_inbox
      WHERE expires_at <= ? AND state IN ('completed', 'exhausted') ORDER BY expires_at LIMIT ?)`
  )
    .bind(now, config.batchSize)
    .run();
  const auditsPurged = await env.DATABASE.prepare(
    `DELETE FROM github_webhook_deliveries WHERE id IN (SELECT id FROM github_webhook_deliveries
      WHERE created_at <= ? ORDER BY created_at LIMIT ?)`
  )
    .bind(new Date(Date.now() - config.dedupRetentionMs).toISOString(), config.batchSize)
    .run();
  const stats = {
    selected: due.results.length,
    recovered: 0,
    exhausted: expiry.meta.changes,
    purged: purged.meta.changes,
    auditsPurged: auditsPurged.meta.changes,
    budgetDeferred: 0,
  };
  const process = async () => {
    const started = Date.now();
    if (expiry.meta.changes) await alertExhaustion(env);
    for (const [index, row] of due.results.entries()) {
      if (Date.now() - started >= config.maxWallTimeMs) {
        stats.budgetDeferred = due.results.length - index;
        break;
      }
      try {
        if (await recoverGitHubTriggerDelivery(env, row.id)) stats.recovered++;
      } catch {
        log.warn('github_triggers.recovery_storage_error', { deliveryId: row.id });
      }
    }
    log.info('github_triggers.recovery_sweep', stats);
    return stats;
  };
  if (waitUntil) {
    // Intake is already durable. Do not put task submission network waits in front
    // of other lifecycle sweeps; one serial background loop avoids a dispatch burst.
    waitUntil(process());
    return { ...stats, recoveryQueued: due.results.length };
  }
  return process();
}
