/**
 * Agent Mailbox — durable message storage and delivery within ProjectData DO.
 *
 * Provides escalating message classes (notify → shutdown_with_final_prompt),
 * a delivery state machine (queued → delivered → acked → expired), and
 * ack-timeout-based re-delivery.
 */
import type {
  AgentMailboxMessage,
  DeliveryState,
  MessageClass,
  SenderType,
} from '@simple-agent-manager/shared';
import {
  DELIVERY_STATE_TRANSITIONS,
  DURABLE_MESSAGE_CLASSES,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { parseMailboxMessageRow } from './row-schemas';

const log = createModuleLogger('mailbox');

// ─── Core operations ───────────────────────────────────────────────────────

export interface EnqueueOptions {
  targetSessionId: string;
  sourceTaskId: string | null;
  senderType: SenderType;
  senderId: string | null;
  messageClass: MessageClass;
  content: string;
  metadata?: Record<string, unknown> | null;
  ackTimeoutMs?: number | null;
  ttlMs?: number | null;
  maxMessages?: number;
}

/**
 * Insert a new message into the mailbox with delivery_state='queued'.
 * For 'notify' class, ack is not required. For durable classes, ack is required.
 */
export function enqueueMessage(
  sql: SqlStorage,
  opts: EnqueueOptions,
): AgentMailboxMessage {
  const id = ulid();
  const now = Date.now();
  const isDurable = (DURABLE_MESSAGE_CLASSES as readonly string[]).includes(opts.messageClass);
  const ackRequired = isDurable ? 1 : 0;
  const expiresAt = opts.ttlMs ? now + opts.ttlMs : null;

  // Enforce per-project message cap
  if (opts.maxMessages) {
    const [countRow] = sql
      .exec('SELECT COUNT(*) as cnt FROM session_inbox WHERE delivery_state NOT IN (?, ?)', 'acked', 'expired')
      .toArray();
    const count = (countRow as { cnt: number })?.cnt ?? 0;
    if (count >= opts.maxMessages) {
      throw new Error(`Mailbox message limit reached (${opts.maxMessages})`);
    }
  }

  sql.exec(
    `INSERT INTO session_inbox
      (id, target_session_id, source_task_id, message_type, content, priority,
       created_at, delivered_at, message_class, delivery_state, sender_type,
       sender_id, ack_required, acked_at, ack_timeout_ms, expires_at,
       delivery_attempts, last_delivery_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, ?)`,
    id,
    opts.targetSessionId,
    opts.sourceTaskId,
    opts.messageClass, // message_type mirrors message_class for backwards compat
    opts.content,
    isDurable ? 'high' : 'normal', // priority derived from class
    now,
    opts.messageClass,
    'queued',
    opts.senderType,
    opts.senderId,
    ackRequired,
    opts.ackTimeoutMs ?? null,
    expiresAt,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
  );

  log.info('mailbox.enqueued', {
    messageId: id,
    targetSessionId: opts.targetSessionId,
    messageClass: opts.messageClass,
    senderType: opts.senderType,
  });

  return {
    id,
    targetSessionId: opts.targetSessionId,
    sourceTaskId: opts.sourceTaskId,
    senderType: opts.senderType,
    senderId: opts.senderId,
    messageClass: opts.messageClass,
    deliveryState: 'queued',
    content: opts.content,
    metadata: opts.metadata ?? null,
    ackRequired: ackRequired === 1,
    ackTimeoutMs: opts.ackTimeoutMs ?? null,
    deliveryAttempts: 0,
    lastDeliveryAt: null,
    expiresAt,
    createdAt: now,
    deliveredAt: null,
    ackedAt: null,
  };
}

/**
 * Get pending messages for a target session, ordered by urgency (highest class first, then oldest).
 */
export function getPendingMessages(
  sql: SqlStorage,
  targetSessionId: string,
  limit = 50,
): AgentMailboxMessage[] {
  const rows = sql
    .exec(
      `SELECT * FROM session_inbox
       WHERE target_session_id = ?
         AND delivery_state IN ('queued', 'delivered')
       ORDER BY
         CASE message_class
           WHEN 'shutdown_with_final_prompt' THEN 5
           WHEN 'preempt_and_replan' THEN 4
           WHEN 'interrupt' THEN 3
           WHEN 'deliver' THEN 2
           WHEN 'notify' THEN 1
           ELSE 0
         END DESC,
         created_at ASC
       LIMIT ?`,
      targetSessionId,
      limit,
    )
    .toArray();
  return rows.map(parseMailboxMessageRow);
}

/**
 * Get a single message by ID.
 */
export function getMessage(
  sql: SqlStorage,
  messageId: string,
): AgentMailboxMessage | null {
  const [row] = sql.exec('SELECT * FROM session_inbox WHERE id = ?', messageId).toArray();
  return row ? parseMailboxMessageRow(row) : null;
}

/**
 * Transition a message's delivery state. Validates the transition is legal.
 */
function transitionState(
  sql: SqlStorage,
  messageId: string,
  toState: DeliveryState,
): boolean {
  const msg = getMessage(sql, messageId);
  if (!msg) return false;

  const allowed = DELIVERY_STATE_TRANSITIONS[msg.deliveryState];
  if (!allowed.includes(toState)) {
    log.warn('mailbox.invalid_transition', {
      messageId,
      from: msg.deliveryState,
      to: toState,
    });
    return false;
  }

  const now = Date.now();

  if (toState === 'delivered') {
    sql.exec(
      `UPDATE session_inbox SET delivery_state = ?, delivered_at = ?, delivery_attempts = ?, last_delivery_at = ? WHERE id = ?`,
      toState,
      now,
      msg.deliveryAttempts + 1,
      now,
      messageId,
    );
  } else if (toState === 'acked') {
    sql.exec(
      `UPDATE session_inbox SET delivery_state = ?, acked_at = ? WHERE id = ?`,
      toState,
      now,
      messageId,
    );
  } else {
    sql.exec(
      `UPDATE session_inbox SET delivery_state = ? WHERE id = ?`,
      toState,
      messageId,
    );
  }

  return true;
}

/**
 * Mark a message as delivered (called after successful injection into agent session).
 */
export function markDelivered(sql: SqlStorage, messageId: string): boolean {
  return transitionState(sql, messageId, 'delivered');
}

/**
 * Acknowledge a delivered message.
 */
export function acknowledgeMessage(sql: SqlStorage, messageId: string): boolean {
  return transitionState(sql, messageId, 'acked');
}

/**
 * Mark a message as expired.
 */
export function expireMessage(sql: SqlStorage, messageId: string): boolean {
  return transitionState(sql, messageId, 'expired');
}

/**
 * Expire messages that have exceeded their TTL or max delivery attempts.
 */
export function expireStaleMessages(
  sql: SqlStorage,
  maxAttempts: number,
): number {
  const now = Date.now();
  let expired = 0;

  // Expire by TTL
  const ttlRows = sql
    .exec(
      `SELECT id FROM session_inbox
       WHERE expires_at IS NOT NULL
         AND expires_at <= ?
         AND delivery_state NOT IN ('acked', 'expired')`,
      now,
    )
    .toArray();

  for (const row of ttlRows) {
    const r = row as { id: string };
    if (expireMessage(sql, r.id)) expired++;
  }

  // Expire by max attempts
  const attemptRows = sql
    .exec(
      `SELECT id FROM session_inbox
       WHERE delivery_attempts >= ?
         AND delivery_state NOT IN ('acked', 'expired')`,
      maxAttempts,
    )
    .toArray();

  for (const row of attemptRows) {
    const r = row as { id: string };
    if (expireMessage(sql, r.id)) expired++;
  }

  if (expired > 0) {
    log.info('mailbox.expired_stale', { count: expired });
  }

  return expired;
}

/**
 * Get messages that need re-delivery (delivered but not acked within timeout).
 */
export function getUnackedMessages(
  sql: SqlStorage,
  defaultAckTimeoutMs: number,
): AgentMailboxMessage[] {
  const now = Date.now();
  const rows = sql
    .exec(
      `SELECT * FROM session_inbox
       WHERE delivery_state = 'delivered'
         AND ack_required = 1
         AND (
           (ack_timeout_ms IS NOT NULL AND last_delivery_at + ack_timeout_ms <= ?)
           OR (ack_timeout_ms IS NULL AND last_delivery_at + ? <= ?)
         )`,
      now,
      defaultAckTimeoutMs,
      now,
    )
    .toArray();
  return rows.map(parseMailboxMessageRow);
}

/**
 * Re-queue a delivered-but-unacked message for re-delivery.
 * Uses the state machine transition delivered → queued, then clears delivered_at.
 */
export function requeueForRedelivery(sql: SqlStorage, messageId: string): boolean {
  const requeued = transitionState(sql, messageId, 'queued');
  if (requeued) {
    // Clear delivered_at so the message appears fresh for next delivery attempt
    sql.exec(`UPDATE session_inbox SET delivered_at = NULL WHERE id = ?`, messageId);
  }
  return requeued;
}

/**
 * List all messages for a project with optional filters (for REST API / admin).
 */
export function listMessages(
  sql: SqlStorage,
  opts: {
    targetSessionId?: string;
    deliveryState?: DeliveryState;
    messageClass?: MessageClass;
    limit?: number;
    offset?: number;
  } = {},
): { messages: AgentMailboxMessage[]; total: number } {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.targetSessionId) {
    conditions.push('target_session_id = ?');
    params.push(opts.targetSessionId);
  }
  if (opts.deliveryState) {
    conditions.push('delivery_state = ?');
    params.push(opts.deliveryState);
  }
  if (opts.messageClass) {
    conditions.push('message_class = ?');
    params.push(opts.messageClass);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRow] = sql.exec(`SELECT COUNT(*) as cnt FROM session_inbox ${where}`, ...params).toArray();
  const total = (countRow as { cnt: number })?.cnt ?? 0;

  const rows = sql
    .exec(
      `SELECT * FROM session_inbox ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    )
    .toArray();

  return {
    messages: rows.map(parseMailboxMessageRow),
    total,
  };
}

/**
 * Cancel (expire) a queued message by ID. Only queued messages can be cancelled —
 * delivered messages must complete their ack/expire cycle to preserve the audit trail.
 */
export function cancelMessage(sql: SqlStorage, messageId: string): boolean {
  const msg = getMessage(sql, messageId);
  if (!msg) return false;
  if (msg.deliveryState !== 'queued') return false;
  return expireMessage(sql, messageId);
}

/**
 * Get mailbox stats for admin/monitoring.
 */
export function getMailboxStats(sql: SqlStorage): Record<string, number> {
  const rows = sql
    .exec(
      `SELECT delivery_state, COUNT(*) as cnt FROM session_inbox GROUP BY delivery_state`,
    )
    .toArray();

  const stats: Record<string, number> = {
    queued: 0,
    delivered: 0,
    acked: 0,
    expired: 0,
    total: 0,
  };

  for (const row of rows) {
    const r = row as { delivery_state: string; cnt: number };
    stats[r.delivery_state] = r.cnt;
    stats.total = (stats.total ?? 0) + r.cnt;
  }

  return stats;
}

// ─── Delivery sweep (alarm-driven) ─────────────────────────────────────────

/**
 * Run a delivery sweep: expire stale messages, re-queue unacked messages.
 * Called from the DO alarm handler.
 */
export function runDeliverySweep(
  sql: SqlStorage,
  defaultAckTimeoutMs: number,
  maxAttempts: number,
): { expired: number; requeued: number } {
  // 1. Expire stale messages (TTL exceeded or max attempts reached)
  const expired = expireStaleMessages(sql, maxAttempts);

  // 2. Re-queue unacked messages for re-delivery
  const unacked = getUnackedMessages(sql, defaultAckTimeoutMs);
  let requeued = 0;
  for (const msg of unacked) {
    if (requeueForRedelivery(sql, msg.id)) requeued++;
  }

  if (expired > 0 || requeued > 0) {
    log.info('mailbox.delivery_sweep', { expired, requeued });
  }

  return { expired, requeued };
}

/**
 * Compute the next alarm time for the mailbox delivery sweep.
 * Returns null if no messages need attention.
 */
export function computeMailboxAlarmTime(
  sql: SqlStorage,
  pollIntervalMs: number,
): number | null {
  // Check if there are any queued or delivered messages that need attention
  const [row] = sql
    .exec(
      `SELECT COUNT(*) as cnt FROM session_inbox
       WHERE delivery_state IN ('queued', 'delivered')`,
    )
    .toArray();

  const count = (row as { cnt: number })?.cnt ?? 0;
  if (count === 0) return null;

  return Date.now() + pollIntervalMs;
}
