/**
 * Durable deliveries to a chat whose task is held by an AI-provider usage limit.
 *
 * The hold is the task's `provider_limit_wait_json` (D1), written by the provider-limit callback
 * (`parkTaskForProviderLimit`) and by TaskRunner admission (`holdTaskForProviderLimit`). While it
 * holds, a wake cannot start, so a delivery to the sleeping chat can only report `not_ready`.
 * Without this module the delivery TTL expired the person's message and filed a "Couldn't wake"
 * item for a deliberate, multi-day wait (idea 01M7MMRHF3VZRKREC2XBMSC7HF).
 *
 * The hold is applied to every active delivery of the chat whenever one of them learns of it: a
 * claimed delivery that came back `not_ready` (`prompt-delivery-runner.ts`), and a person's new
 * message accepted while the chat sleeps (`durability-foundation.ts`). The second matters because
 * only a lane's head is ever claimed: a later message queued behind a parked one would otherwise
 * keep its ordinary TTL and expire unnoticed.
 *
 * - A `waiting` hold keeps a person's messages until the hold's retry time plus the ordinary
 *   delivery TTL, and parks every delivery until that retry time.
 * - A `blocked` hold (or a `waiting` one past its deadline, which admission is about to block) has
 *   no automatic wake: only the owner's Resume wakes the chat. A person's messages are kept until
 *   the saved snapshot expires (Resume cannot restore past it), and nothing is retried meanwhile.
 *
 * A committed wake nudges every queued delivery (`applySessionWakeReady`), so a parked delivery
 * goes out as soon as the chat wakes. Expiry of a held chat's delivery files no wake failure
 * (`isProviderLimitHoldExpiry`): the chat shows the hold instead.
 */
import {
  parseProviderLimitWait,
  PROVIDER_LIMIT_POLICY,
} from '@simple-agent-manager/scheduler-core';
import { createModuleLogger } from '@simple-agent-manager/worker-core';

import { closeWakeErrorAskForProviderLimit } from './question-asks';

const log = createModuleLogger('project_data.provider_limit_delivery_hold');

const TERMINAL_TASK_STATUSES = "('completed','failed','cancelled')";

export interface ProviderLimitHold {
  taskId: string;
  phase: 'waiting' | 'blocked';
  nextRetryAt: number;
  deadlineAt: number;
  /** When the chat's saved snapshot expires (ms), or null when unknown. */
  snapshotExpiresAt: number | null;
}

/**
 * The provider-limit hold of the live task bound to this chat, or null. One D1 read. A `waiting`
 * hold past its `deadlineAt` is still a hold: TaskRunner admission turns it `blocked` on its next
 * run, and until then nothing about the chat is a wake failure.
 */
export async function readProviderLimitHold(
  database: D1Database,
  projectId: string,
  sessionId: string
): Promise<ProviderLimitHold | null> {
  const row = await database
    .prepare(
      `SELECT t.id, t.provider_limit_wait_json,
              (SELECT s.expires_at FROM session_snapshots s
                WHERE s.project_id = t.project_id AND s.chat_session_id = t.chat_session_id
                LIMIT 1) AS snapshot_expires_at
         FROM tasks t
        WHERE t.project_id = ? AND t.chat_session_id = ? AND t.status NOT IN ${TERMINAL_TASK_STATUSES}
        ORDER BY t.updated_at DESC LIMIT 1`
    )
    .bind(projectId, sessionId)
    .first<{
      id: string;
      provider_limit_wait_json: string | null;
      snapshot_expires_at: string | null;
    }>();
  const wait = parseProviderLimitWait(row?.provider_limit_wait_json);
  if (!row || !wait || wait.phase === 'released') return null;
  const snapshotExpiresAt = row.snapshot_expires_at ? Date.parse(row.snapshot_expires_at) : NaN;
  return {
    taskId: row.id,
    phase: wait.phase,
    nextRetryAt: wait.nextRetryAt,
    deadlineAt: wait.deadlineAt,
    snapshotExpiresAt: Number.isFinite(snapshotExpiresAt) ? snapshotExpiresAt : null,
  };
}

/** A `waiting` hold whose retry the TaskRunner will still run (its deadline has not passed). */
export function isActiveProviderLimitWait(hold: ProviderLimitHold, now: number): boolean {
  return hold.phase === 'waiting' && hold.deadlineAt > now;
}

/**
 * The chat's wake state, read before the D1 hold lookup and compared after it. Only a sleeping
 * chat is waiting on a wake. A wake that commits while the hold is read nudges the chat's
 * deliveries (`applySessionWakeReady`); parking them again would strand them until a stale retry
 * time. A VM wake makes the chat active; an Instant (cf-container) wake leaves it `sleeping` but
 * writes a new readiness fence, so both are compared.
 */
function readWakeState(sql: SqlStorage, sessionId: string): string | null {
  const session = sql.exec('SELECT status FROM chat_sessions WHERE id = ?', sessionId).toArray()[0];
  if (session?.status !== 'sleeping') return null;
  const readiness = sql
    .exec('SELECT fence, ready_at FROM session_wake_readiness WHERE session_id = ?', sessionId)
    .toArray()[0];
  return JSON.stringify([readiness?.fence ?? null, readiness?.ready_at ?? null]);
}

/**
 * Keep a held chat's deliveries for the hold. Synchronous; returns the number of rows changed.
 *
 * Only a person's messages (`sender_type = 'human'`) are kept past their deadline: other sources
 * carry their own absolute deadlines (event batches, schedules, parent wakes) that a hold must not
 * stretch. Every active delivery is parked, since none can be delivered before the hold ends.
 */
export function holdPromptDeliveriesForProviderLimit(
  sql: SqlStorage,
  sessionId: string,
  hold: ProviderLimitHold,
  ttlMs: number,
  now: number
): number {
  let keepUntil: number;
  let parkUntil: number | null;
  if (isActiveProviderLimitWait(hold, now)) {
    keepUntil = Math.max(hold.deadlineAt, hold.nextRetryAt + ttlMs);
    parkUntil = hold.nextRetryAt;
  } else {
    // No automatic wake: keep a person's message while Resume can still restore the chat, capped
    // by the longest reset a hold may wait for. Each delivery is parked to its own expiry.
    keepUntil = Math.min(
      hold.snapshotExpiresAt ?? now + ttlMs,
      now + PROVIDER_LIMIT_POLICY.maxResetDelayMs
    );
    parkUntil = null;
  }
  const extended = sql.exec(
    `UPDATE session_inbox SET expires_at = ?
      WHERE target_session_id = ? AND sender_type = 'human'
        AND delivery_state IN ('queued', 'retry_wait', 'delivering')
        AND expires_at IS NOT NULL AND expires_at < ?`,
    keepUntil,
    sessionId,
    keepUntil
  ).rowsWritten;
  const parked =
    parkUntil === null
      ? sql.exec(
          `UPDATE session_inbox SET next_attempt_at = expires_at
            WHERE target_session_id = ? AND delivery_state IN ('queued', 'retry_wait')
              AND expires_at IS NOT NULL AND COALESCE(next_attempt_at, 0) < expires_at`,
          sessionId
        ).rowsWritten
      : sql.exec(
          `UPDATE session_inbox SET next_attempt_at = ?
            WHERE target_session_id = ? AND delivery_state IN ('queued', 'retry_wait')
              AND COALESCE(next_attempt_at, 0) < ?`,
          parkUntil,
          sessionId,
          parkUntil
        ).rowsWritten;
  return extended + parked;
}

/**
 * If this sleeping chat's task is held by a provider limit, keep and park its deliveries and close
 * an open "Couldn't wake" item, which the hold supersedes (the chat shows the hold instead). Never
 * throws: on a failed read the deliveries keep their ordinary backoff and TTL. Returns null when
 * nothing was held (not sleeping, no hold, failed read, or the chat woke during the read).
 */
export async function applyProviderLimitDeliveryHold(
  sql: SqlStorage,
  database: D1Database,
  input: { projectId: string; sessionId: string; ttlMs: number; now?: number }
): Promise<{ hold: ProviderLimitHold; rowsChanged: number; closedWakeAsks: number } | null> {
  const before = readWakeState(sql, input.sessionId);
  if (before === null) return null;
  let hold: ProviderLimitHold | null;
  try {
    hold = await readProviderLimitHold(database, input.projectId, input.sessionId);
  } catch (error) {
    log.warn('read_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
      action: 'kept_ordinary_backoff',
    });
    return null;
  }
  if (!hold) return null;
  // Synchronous from here to the write: nothing can interleave with the comparison.
  if (readWakeState(sql, input.sessionId) !== before) {
    log.info('skipped_woken_during_read', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: hold.taskId,
    });
    return null;
  }
  const now = input.now ?? Date.now();
  const rowsChanged = holdPromptDeliveriesForProviderLimit(
    sql,
    input.sessionId,
    hold,
    input.ttlMs,
    now
  );
  log.info('applied', {
    projectId: input.projectId,
    sessionId: input.sessionId,
    taskId: hold.taskId,
    phase: hold.phase,
    nextRetryAt: hold.nextRetryAt,
    deadlineAt: hold.deadlineAt,
    snapshotExpiresAt: hold.snapshotExpiresAt,
    rowsChanged,
  });
  // Never throws: closeChatErrorAsks logs its own failure and reports 0.
  const closedWakeAsks = await closeWakeErrorAskForProviderLimit(database, {
    projectId: input.projectId,
    sessionId: input.sessionId,
  });
  return { hold, rowsChanged, closedWakeAsks };
}

/**
 * Whether a delivery that just expired on its TTL belongs to a chat held by a provider limit, so
 * the expiry is the hold, not a failed wake. A failed read answers false: the failure stays
 * visible rather than silently swallowed.
 */
export async function isProviderLimitHoldExpiry(
  database: D1Database,
  projectId: string | null,
  sessionId: string
): Promise<boolean> {
  if (!projectId) return false;
  try {
    return (await readProviderLimitHold(database, projectId, sessionId)) !== null;
  } catch (error) {
    log.warn('expiry_read_failed', {
      projectId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
      action: 'filed_wake_failure',
    });
    return false;
  }
}
