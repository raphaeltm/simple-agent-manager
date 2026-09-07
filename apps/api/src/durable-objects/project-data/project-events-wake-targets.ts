import { MAILBOX_DEFAULTS } from '@simple-agent-manager/shared';

import { resolveMaxMessagesPerSession } from './messages-persist-helpers';
import type { Env } from './types';

export function isTargetAtWakeCapacity(sql: SqlStorage, env: Env, sessionId: string): boolean {
  const maxTranscriptMessages = resolveMaxMessagesPerSession(env);
  const messageRow = sql
    .exec('SELECT message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  const currentMessages =
    typeof messageRow?.message_count === 'number'
      ? messageRow.message_count
      : maxTranscriptMessages;
  if (currentMessages >= maxTranscriptMessages) return true;
  const maxMailboxMessages = resolveMailboxMaxMessages(env);
  const row = sql
    .exec(
      `SELECT COUNT(*) AS cnt
       FROM session_inbox
       WHERE delivery_state NOT IN ('acked', 'failed', 'ambiguous', 'expired')`
    )
    .toArray()[0];
  const activeMailboxRows = typeof row?.cnt === 'number' ? row.cnt : maxMailboxMessages;
  return activeMailboxRows >= maxMailboxMessages;
}

export function readLivePromptBatchLeaseUntilForTarget(
  sql: SqlStorage,
  projectId: string,
  sessionId: string,
  now: number
): number | null {
  const row = sql
    .exec(
      `SELECT MIN(
                CASE
                  WHEN state = 'delivered' THEN readable_until
                  WHEN delivery_expires_at IS NOT NULL THEN delivery_expires_at
                  ELSE readable_until
                END
              ) AS lease_until
       FROM project_event_delivery_batches
       WHERE project_id = ?
         AND delivery_channel = 'prompt_queue'
         AND target_session_id = ?
         AND state IN ('pending', 'delivered')
         AND (
           (state = 'pending' AND (delivery_expires_at IS NULL OR delivery_expires_at > ?))
           OR (state = 'delivered' AND readable_until IS NOT NULL AND readable_until > ?)
         )`,
      projectId,
      sessionId,
      now,
      now
    )
    .toArray()[0];
  return typeof row?.lease_until === 'number' && row.lease_until > now ? row.lease_until : null;
}

export function deferWakeTarget(
  sql: SqlStorage,
  projectId: string,
  sessionId: string,
  nextAt: number,
  now: number
): void {
  sql.exec(
    `UPDATE project_event_subscriptions
     SET delivery_cooldown_until = CASE
           WHEN delivery_cooldown_until IS NULL OR delivery_cooldown_until < ? THEN ?
           ELSE delivery_cooldown_until
         END,
         wake_due_at = CASE
           WHEN wake_due_at IS NOT NULL AND wake_due_at < ? THEN wake_due_at
           ELSE ?
         END,
         updated_at = ?
     WHERE project_id = ?
       AND target_session_id = ?
       AND contract_version >= 2
       AND lifecycle_state = 'active'
       AND requested_delivery = 'existing_session_prompt'
       AND resolved_delivery = 'queued_for_prompt_delivery'`,
    nextAt,
    nextAt,
    nextAt,
    nextAt,
    now,
    projectId,
    sessionId
  );
}

export function resolveMailboxMaxMessages(env: Env): number {
  const parsed = Number.parseInt(env.MAILBOX_MAX_MESSAGES_PER_PROJECT ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : MAILBOX_DEFAULTS.MAX_MESSAGES_PER_PROJECT;
}
