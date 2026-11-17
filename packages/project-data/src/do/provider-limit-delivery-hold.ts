/**
 * Durable deliveries to a chat whose task is held by an AI-provider usage limit.
 *
 * The hold is the task's `provider_limit_wait_json` (D1), written by the provider-limit callback
 * (`parkTaskForProviderLimit`) and by TaskRunner admission (`holdTaskForProviderLimit`). While it
 * holds, a wake cannot start, so a delivery to the sleeping chat can only report `not_ready`.
 * Without this module the delivery TTL expired the person's message and filed a "Couldn't wake"
 * item for a deliberate, multi-day wait (idea 01M7MMRHF3VZRKREC2XBMSC7HF).
 *
 * A `waiting` hold keeps a person's message until the hold's retry time plus the ordinary
 * delivery TTL, and parks retries until that retry time: a committed wake nudges every queued
 * delivery (`applySessionWakeReady`), so nothing waits for the parked time once the chat wakes. A
 * `blocked` hold has no automatic wake (the owner must resume), so its deliveries are parked until
 * their own expiry without being extended. In both cases expiry files no wake failure
 * (`isProviderLimitHoldExpiry`).
 */
import { parseProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import { createModuleLogger } from '@simple-agent-manager/worker-core';

import { closeWakeErrorAskForProviderLimit } from './question-asks';

const log = createModuleLogger('project_data.provider_limit_delivery_hold');

const TERMINAL_TASK_STATUSES = "('completed','failed','cancelled')";

export interface ProviderLimitHold {
  taskId: string;
  phase: 'waiting' | 'blocked';
  nextRetryAt: number;
  deadlineAt: number;
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
      `SELECT id, provider_limit_wait_json FROM tasks
        WHERE project_id = ? AND chat_session_id = ? AND status NOT IN ${TERMINAL_TASK_STATUSES}
        ORDER BY updated_at DESC LIMIT 1`
    )
    .bind(projectId, sessionId)
    .first<{ id: string; provider_limit_wait_json: string | null }>();
  const wait = parseProviderLimitWait(row?.provider_limit_wait_json);
  if (!row || !wait || wait.phase === 'released') return null;
  return {
    taskId: row.id,
    phase: wait.phase,
    nextRetryAt: wait.nextRetryAt,
    deadlineAt: wait.deadlineAt,
  };
}

/** Only a sleeping chat is waiting on a wake; an awake chat's `not_ready` is not a hold. */
function isChatSleeping(sql: SqlStorage, sessionId: string): boolean {
  return (
    sql
      .exec(`SELECT 1 FROM chat_sessions WHERE id = ? AND status = 'sleeping'`, sessionId)
      .toArray().length > 0
  );
}

/** A `waiting` hold whose retry the TaskRunner will still run (its deadline has not passed). */
export function isActiveProviderLimitWait(hold: ProviderLimitHold, now: number): boolean {
  return hold.phase === 'waiting' && hold.deadlineAt > now;
}

/**
 * Keep a held chat's deliveries for the hold, synchronously after the hold was read.
 * Returns the number of delivery rows changed.
 *
 * Only a person's messages (`sender_type = 'human'`) are kept past their deadline: other sources
 * carry their own absolute deadlines (event batches, schedules, parent wakes) that a hold must not
 * stretch. Every active delivery to the chat is parked, since none can be delivered before the
 * hold ends; an urgent or steer lane included, because a held chat has no turn to steer.
 */
export function holdPromptDeliveriesForProviderLimit(
  sql: SqlStorage,
  sessionId: string,
  hold: ProviderLimitHold,
  ttlMs: number,
  now: number
): number {
  // Re-checked synchronously at write time: a wake that committed while the hold was being read
  // made the chat active and nudged its deliveries (`applySessionWakeReady`); parking them again
  // would strand them until the stale retry time.
  if (!isChatSleeping(sql, sessionId)) return 0;
  if (isActiveProviderLimitWait(hold, now)) {
    const keepUntil = Math.max(hold.deadlineAt, hold.nextRetryAt + ttlMs);
    const extended = sql.exec(
      `UPDATE session_inbox SET expires_at = ?
        WHERE target_session_id = ? AND sender_type = 'human'
          AND delivery_state IN ('queued', 'retry_wait', 'delivering')
          AND expires_at IS NOT NULL AND expires_at < ?`,
      keepUntil,
      sessionId,
      keepUntil
    ).rowsWritten;
    const parked = sql.exec(
      `UPDATE session_inbox SET next_attempt_at = ?
        WHERE target_session_id = ? AND delivery_state IN ('queued', 'retry_wait')
          AND COALESCE(next_attempt_at, 0) < ?`,
      hold.nextRetryAt,
      sessionId,
      hold.nextRetryAt
    ).rowsWritten;
    return extended + parked;
  }
  // Blocked (or past its deadline): no automatic wake will come. Stop retrying until each
  // delivery's own expiry; an owner resume wakes the chat and its readiness nudge releases them.
  return sql.exec(
    `UPDATE session_inbox SET next_attempt_at = expires_at
      WHERE target_session_id = ? AND delivery_state IN ('queued', 'retry_wait')
        AND expires_at IS NOT NULL AND COALESCE(next_attempt_at, 0) < expires_at`,
    sessionId
  ).rowsWritten;
}

/**
 * After a delivery to a sleeping chat came back `not_ready`: if the chat's task is held by a
 * provider limit, keep and park its deliveries and close an open "Couldn't wake" item, which the
 * hold supersedes (the chat shows the hold instead). Never throws: on a failed read the delivery
 * keeps its ordinary backoff and TTL.
 */
export async function applyProviderLimitDeliveryHold(
  sql: SqlStorage,
  database: D1Database,
  input: { projectId: string; sessionId: string; ttlMs: number; now?: number }
): Promise<{ hold: ProviderLimitHold; closedWakeAsks: number } | null> {
  if (!isChatSleeping(sql, input.sessionId)) return null;
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
  // The read awaited D1, so re-check "now" for the synchronous write.
  const now = input.now ?? Date.now();
  const changed = holdPromptDeliveriesForProviderLimit(
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
    rowsChanged: changed,
  });
  // Never throws: closeChatErrorAsks logs its own failure and reports 0.
  const closedWakeAsks = await closeWakeErrorAskForProviderLimit(database, {
    projectId: input.projectId,
    sessionId: input.sessionId,
  });
  return { hold, closedWakeAsks };
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
