import {
  type AgentMailboxMessage,
  canSteerMessageClass,
  type MessageClass,
  type PromptDeliveryIntent,
  type PromptDeliverySource,
  type SamNotice,
  type SenderType,
  type VmPromptDeliveryCapabilities,
} from '@simple-agent-manager/shared';
import { createModuleLogger } from '@simple-agent-manager/worker-core';
import { ulid } from '@simple-agent-manager/worker-core';

import type { DurableExecutionConfig } from './durable-execution-config';
import * as mailbox from './mailbox';
import * as messages from './messages';
import { parseMailboxMessageRow } from './row-schemas';
import { promptDeliveryToolMetadata } from './sam-notice-metadata';
import type { Env } from './types';

export {
  type AcceptedDeliveryResult,
  applyPromptDeliveryResult,
  type PromptDeliveryResult,
} from './prompt-delivery-results';

const log = createModuleLogger('project_data.prompt_delivery');
export interface AcceptPromptDeliveryInput {
  deliveryId?: string;
  targetSessionId: string;
  displayContent: string;
  deliveryContent?: string;
  sourceTaskId?: string | null;
  senderType: SenderType;
  senderId?: string | null;
  messageClass?: MessageClass;
  /** `steer` adds the message to the running turn when possible; default `queue`. */
  deliveryIntent?: PromptDeliveryIntent;
  sourceKind: PromptDeliverySource;
  metadata?: Record<string, unknown> | null;
  /**
   * Server-built description of this message for the chat UI. Only trusted server code sets
   * it; a `samNotice` key inside `metadata` (which can carry caller data) is discarded.
   */
  notice?: SamNotice | null;
  ackTimeoutMs?: number | null;
  ttlMs?: number | null;
  /** Absolute source deadline; retries cannot extend it. */
  expiresAt?: number | null;
  maxMessages?: number;
}

export interface AcceptedPromptDelivery {
  message: AgentMailboxMessage;
  transcriptMessageId: string;
  transcriptInserted: boolean;
  transcriptCreatedAt: number;
  transcriptSequence: number;
  workspaceId: string | null;
}

export function acceptPromptDeliveryInTransaction(
  sql: SqlStorage,
  env: Env,
  input: AcceptPromptDeliveryInput,
  now = Date.now()
): AcceptedPromptDelivery {
  const targetSessionId = input.targetSessionId.trim();
  const displayContent = input.sourceKind === 'inbox_reply' ? input.displayContent : input.displayContent.trim();
  const deliveryContent = (input.deliveryContent ?? input.displayContent).trim();
  if (!targetSessionId) throw new Error('targetSessionId is required');
  if (!displayContent || !deliveryContent) throw new Error('prompt content is required');
  const deliveryIntent = input.deliveryIntent ?? 'queue';
  if (deliveryIntent === 'steer' && !canSteerMessageClass(input.messageClass ?? 'deliver')) {
    // Urgency already has a path (stop-and-deliver); a steer never interrupts.
    throw new Error('steer intent requires a non-urgent message class');
  }

  const existing = input.deliveryId ? mailbox.getMessage(sql, input.deliveryId) : null;
  if (existing) {
    if (
      existing.targetSessionId !== targetSessionId ||
      existing.sourceKind !== input.sourceKind ||
      existing.content !== deliveryContent ||
      existing.deliveryIntent !== deliveryIntent
    ) {
      throw new Error('deliveryId already belongs to a different prompt intent');
    }
    return {
      message: existing,
      transcriptMessageId: existing.promptMessageId,
      transcriptInserted: false,
      transcriptCreatedAt: existing.createdAt,
      transcriptSequence: 0,
      workspaceId: null,
    };
  }

  const deliveryId = input.deliveryId ?? ulid();
  const toolMetadata = JSON.stringify(
    promptDeliveryToolMetadata(input, deliveryId, deliveryIntent)
  );
  const persisted = messages.persistMessage(
    sql,
    env,
    targetSessionId,
    'user',
    displayContent,
    toolMetadata,
    deliveryId
  );
  const delivery = mailbox.enqueueMessage(sql, {
    id: deliveryId,
    targetSessionId,
    sourceTaskId: input.sourceTaskId ?? null,
    senderType: input.senderType,
    senderId: input.senderId ?? null,
    messageClass: input.messageClass ?? 'deliver',
    content: deliveryContent,
    metadata: input.metadata ?? null,
    ackTimeoutMs: input.ackTimeoutMs ?? null,
    ttlMs: input.ttlMs ?? null,
    expiresAt: input.expiresAt ?? null,
    maxMessages: input.maxMessages,
    sourceKind: input.sourceKind,
    promptMessageId: persisted.id,
    now,
    ackRequired: false,
    durableDelivery: true,
    deliveryIntent,
  });

  return {
    message: delivery,
    transcriptMessageId: persisted.id,
    transcriptInserted: persisted.inserted,
    transcriptCreatedAt: persisted.now,
    transcriptSequence: persisted.sequence,
    workspaceId: persisted.workspaceId,
  };
}

export const acceptPromptDelivery = acceptPromptDeliveryInTransaction;

export type DeliveryClaimMode = 'submit' | 'reconcile';

export interface PromptDeliveryClaim {
  message: AgentMailboxMessage;
  attemptId: string;
  mode: DeliveryClaimMode;
}

export function expireDuePromptDeliveries(
  sql: SqlStorage,
  config: DurableExecutionConfig,
  now = Date.now()
): {
  expired: number;
  failed: number;
  expiredWakeFailures: ExpiredWakeDelivery[];
} {
  const expiredWakeFailures = listExpiringWakeDeliveries(sql, now);
  const expired = sql.exec(
    `UPDATE session_inbox INDEXED BY idx_inbox_active_expiry
     SET delivery_state = 'expired',
         terminal_reason = 'ttl_expired',
         last_error = COALESCE(last_error, 'Prompt delivery TTL expired')
     WHERE delivery_state IN ('queued', 'retry_wait', 'delivering')
       AND expires_at IS NOT NULL
       AND expires_at <= ?`,
    now
  ).rowsWritten;
  const failed = sql.exec(
    `UPDATE session_inbox INDEXED BY idx_inbox_pending_attempts
     SET delivery_state = 'failed',
         terminal_reason = 'max_attempts_exceeded',
         last_error = COALESCE(last_error, 'Prompt delivery maximum attempts exceeded')
     WHERE delivery_state IN ('queued', 'retry_wait')
       AND delivery_attempts >= ?`,
    config.maxAttempts
  ).rowsWritten;
  if (expired + failed > 0) {
    sql.exec(`DELETE FROM prompt_delivery_target_backoff
      WHERE NOT EXISTS (SELECT 1 FROM session_inbox INDEXED BY idx_inbox_active_target_head
        WHERE target_session_id = prompt_delivery_target_backoff.target_session_id
          AND delivery_state IN ('queued', 'retry_wait', 'delivering'))`);
  }
  return { expired, failed, expiredWakeFailures };
}

export interface ExpiredWakeDelivery {
  deliveryId: string;
  targetSessionId: string;
  sourceTaskId: string | null;
  lastError: string | null;
  terminalReason: string;
  /** `human` for a person's message, which a provider-limit hold keeps rather than expires. */
  senderType: string;
}

function listExpiringWakeDeliveries(sql: SqlStorage, now: number): ExpiredWakeDelivery[] {
  return sql
    .exec(
      `SELECT inbox.id AS delivery_id,
              inbox.target_session_id,
              inbox.source_task_id,
              inbox.last_error,
              inbox.sender_type,
              'ttl_expired' AS terminal_reason
         FROM session_inbox inbox INDEXED BY idx_inbox_active_expiry
         JOIN chat_sessions session ON session.id = inbox.target_session_id
        WHERE inbox.delivery_state IN ('queued', 'retry_wait', 'delivering')
          AND inbox.expires_at IS NOT NULL
          AND inbox.expires_at <= ?
          AND inbox.source_kind IN ('user_followup', 'inbox_reply', 'parent_wakeup', 'project_event_wake', 'github_trigger', 'scheduled_action', 'operations_decision', 'secret_request', 'inbox_ask', 'checkpoint_continuation')
          AND session.status = 'sleeping'`,
      now
    )
    .toArray()
    .map((row) => ({
      deliveryId: String(row.delivery_id),
      targetSessionId: String(row.target_session_id),
      sourceTaskId: typeof row.source_task_id === 'string' ? row.source_task_id : null,
      lastError: typeof row.last_error === 'string' ? row.last_error : null,
      terminalReason: String(row.terminal_reason),
      senderType: String(row.sender_type),
    }));
}

export function failParentWakeDeliveries(
  sql: SqlStorage,
  parentTaskId: string,
  now = Date.now()
): number {
  return sql.exec(
    `UPDATE session_inbox
     SET delivery_state = 'failed',
         terminal_reason = 'terminal_target',
         last_error = 'Parent task became terminal before wake delivery',
         next_attempt_at = NULL,
         attempt_started_at = NULL
     WHERE source_kind = 'parent_wakeup'
       AND source_task_id = ?
       AND delivery_state IN ('queued', 'retry_wait', 'delivering', 'delivered')
       AND created_at <= ?`,
    parentTaskId,
    now
  ).rowsWritten;
}

/** Message-class precedence is protocol semantics, shared by claims and alarm eligibility. */
function deliveryPrioritySql(alias: string): string {
  const prefix = alias ? `${alias}.` : '';
  return `CASE ${prefix}message_class
    WHEN 'shutdown_with_final_prompt' THEN 5 WHEN 'preempt_and_replan' THEN 4
    WHEN 'interrupt' THEN 3 WHEN 'deliver' THEN 2 WHEN 'notify' THEN 1 ELSE 0 END`;
}

// Each intent is its own lane with its own head: a steer never waits behind a
// queued prompt (that would defeat steering), and a queued prompt never waits
// behind a steer. Within a lane delivery stays ordered and single-flight.
function noEarlierDeliverySql(): string {
  return `inbox.id = (SELECT active.id FROM session_inbox active
    INDEXED BY idx_inbox_active_target_head
    WHERE active.target_session_id = inbox.target_session_id
      AND active.delivery_intent = inbox.delivery_intent
      AND active.delivery_state IN ('queued', 'retry_wait', 'delivering')
    ORDER BY (active.delivery_state = 'delivering') DESC,
      ${deliveryPrioritySql('active')} DESC, active.created_at, active.rowid
    LIMIT 1)`;
}

// Urgent controls can still preempt a target whose informational messages are
// backed off. Equal/lower priority messages share the target's single retry wake.
// The backoff exists because the target is busy, which is exactly when a steer
// is useful, so the steer lane never waits on it.
const TARGET_BACKOFF_SQL = `CASE WHEN inbox.delivery_intent = 'steer' THEN 0 ELSE COALESCE((SELECT next_attempt_at
  FROM prompt_delivery_target_backoff target
  WHERE target.target_session_id = inbox.target_session_id
    AND (${deliveryPrioritySql('inbox')} <= 2
      OR target.message_priority >= ${deliveryPrioritySql('inbox')})), 0) END`;

// Split the states so each arm can range-seek its due-time index. Only active
// rows participate in the head lookup; retained mailbox history is never scanned.
const CLAIM_DUE_PROMPT_DELIVERIES_SQL = `SELECT * FROM (
  SELECT inbox.*, inbox.rowid AS queue_order FROM session_inbox inbox
    INDEXED BY idx_inbox_pending_due
    WHERE delivery_state IN ('queued', 'retry_wait')
      AND COALESCE(next_attempt_at, created_at) <= ?
      AND delivery_attempts < ?
      AND ${TARGET_BACKOFF_SQL} <= ?
      AND ${noEarlierDeliverySql()}
  UNION ALL
  SELECT inbox.*, inbox.rowid AS queue_order FROM session_inbox inbox
    WHERE delivery_state = 'delivering'
      AND attempt_started_at IS NOT NULL AND attempt_started_at <= ?
) ORDER BY ${deliveryPrioritySql('')} DESC, created_at, queue_order LIMIT ?`;

const PROMPT_DELIVERY_ALARM_SQL = `SELECT MIN(due_at) AS due_at FROM (
  SELECT MIN(MAX(COALESCE(next_attempt_at, created_at), ${TARGET_BACKOFF_SQL})) AS due_at
    FROM session_inbox inbox INDEXED BY idx_inbox_pending_due
    WHERE delivery_state IN ('queued', 'retry_wait') AND ${noEarlierDeliverySql()}
  UNION ALL
  SELECT MIN(attempt_started_at) + ? AS due_at FROM session_inbox
    WHERE delivery_state = 'delivering' AND attempt_started_at IS NOT NULL
  UNION ALL
  SELECT MIN(expires_at) AS due_at FROM session_inbox INDEXED BY idx_inbox_active_expiry
    WHERE delivery_state IN ('queued', 'retry_wait', 'delivering')
      AND expires_at IS NOT NULL
)`;

export function claimDuePromptDeliveries(
  sql: SqlStorage,
  config: DurableExecutionConfig,
  now = Date.now()
): PromptDeliveryClaim[] {
  expireDuePromptDeliveries(sql, config, now);
  const staleBefore = now - config.receiptTimeoutMs;
  const rows = sql
    .exec(
      CLAIM_DUE_PROMPT_DELIVERIES_SQL,
      now,
      config.maxAttempts,
      now,
      staleBefore,
      config.maxCandidatesPerAlarm
    )
    .toArray();

  const claims: PromptDeliveryClaim[] = [];
  // One claim per target and lane per pass: a steer may run beside the queued prompt.
  const claimedLanes = new Set<string>();
  const laneKey = (target: unknown, intent: unknown) =>
    `${String(target)}\u0000${String(intent ?? 'queue')}`;
  for (const row of rows) {
    if (claimedLanes.has(laneKey(row.target_session_id, row.delivery_intent))) continue;
    let message: AgentMailboxMessage;
    try {
      message = parseMailboxMessageRow(row);
    } catch (error) {
      log.warn('prompt_delivery.claim_row_skipped', {
        messageId: typeof row.id === 'string' ? row.id : null,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const wasDelivering = message.deliveryState === 'delivering';
    // Only the positive, durable preparation checkpoint proves that no prompt
    // submission began. Old NULL-phase claims and submitting claims reconcile.
    const mode: DeliveryClaimMode =
      wasDelivering && row.prompt_delivery_phase !== 'preparing' ? 'reconcile' : 'submit';
    const attemptId = ulid();
    const result = !wasDelivering
      ? sql.exec(
          `UPDATE session_inbox
           SET delivery_state = 'delivering',
               prompt_delivery_phase = 'preparing',
               wake_ready_attempt_id = NULL,
               delivery_attempts = delivery_attempts + 1,
               attempt_id = ?,
               attempt_started_at = ?,
               last_delivery_at = ?,
               last_error = NULL
           WHERE id = ?
             AND delivery_state IN ('queued', 'retry_wait')
             AND COALESCE(next_attempt_at, created_at) <= ?`,
          attemptId,
          now,
          now,
          message.id,
          now
        )
      : sql.exec(
          `UPDATE session_inbox
           SET attempt_id = ?, attempt_started_at = ?
           WHERE id = ?
             AND delivery_state = 'delivering'
             AND attempt_started_at <= ?`,
          attemptId,
          now,
          message.id,
          staleBefore
        );
    if (result.rowsWritten === 0) continue;
    const claimed = mailbox.getMessage(sql, message.id);
    if (claimed) {
      claimedLanes.add(laneKey(claimed.targetSessionId, claimed.deliveryIntent));
      claims.push({ message: claimed, attemptId, mode });
    }
  }
  return claims;
}

/** Verify the exact live claim, including the durable possible-send checkpoint. */
export function promptDeliveryClaimIsCurrent(sql: SqlStorage, claim: PromptDeliveryClaim): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM session_inbox WHERE id = ? AND target_session_id = ?
       AND delivery_state = 'delivering' AND attempt_id = ?
       AND ((? = 'submit' AND prompt_delivery_phase IN ('preparing', 'submitting'))
         OR (? = 'reconcile' AND (prompt_delivery_phase = 'submitting' OR prompt_delivery_phase IS NULL)))`,
        claim.message.id,
        claim.message.targetSessionId,
        claim.attemptId,
        claim.mode,
        claim.mode
      )
      .toArray().length > 0
  );
}

/** A current possible-send checkpoint cannot turn a failed authority read into a fresh submit. */
export function promptDeliveryClaimSubmissionCheckpoint(
  sql: SqlStorage,
  claim: PromptDeliveryClaim
): { runtimeIdentity: string | null } | null {
  const row = sql
    .exec(
      `SELECT runtime_identity FROM session_inbox WHERE id=? AND target_session_id=?
       AND delivery_state='delivering' AND attempt_id=?
       AND (prompt_delivery_phase='submitting' OR prompt_delivery_phase IS NULL)`,
      claim.message.id,
      claim.message.targetSessionId,
      claim.attemptId
    )
    .toArray()[0];
  return row
    ? { runtimeIdentity: typeof row.runtime_identity === 'string' ? row.runtime_identity : null }
    : null;
}

/** Persist the possible-send boundary and reject preparation owned by an older attempt. */
export function markPromptDeliverySubmitting(
  sql: SqlStorage,
  claim: PromptDeliveryClaim,
  capabilities: VmPromptDeliveryCapabilities
): boolean {
  return (
    sql.exec(
      `UPDATE session_inbox
     SET prompt_delivery_phase = 'submitting', runtime_identity = ?,
         adapter_protocol_version = ?, receipt_supported = ?
     WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?
       AND prompt_delivery_phase = 'preparing'`,
      capabilities.runtimeIdentity,
      capabilities.protocolVersion,
      capabilities.promptReceipts.supported ? 1 : 0,
      claim.message.id,
      claim.attemptId
    ).rowsWritten > 0
  );
}

export function nudgePromptDeliveriesForTarget(
  sql: SqlStorage,
  targetSessionId: string,
  now = Date.now()
): number {
  const released = sql.exec(
    'DELETE FROM prompt_delivery_target_backoff WHERE target_session_id = ?',
    targetSessionId
  ).rowsWritten;
  // An idle callback can land while the adapter is still returning "busy".
  // Latch it on that exact pre-submit attempt so the late result cannot park it.
  const preparing = sql.exec(
    `UPDATE session_inbox SET wake_ready_attempt_id = attempt_id
      WHERE target_session_id = ? AND delivery_state = 'delivering'
        AND prompt_delivery_phase = 'preparing'
        AND wake_ready_attempt_id IS NOT attempt_id`,
    targetSessionId
  ).rowsWritten;
  const queued = sql.exec(
    `UPDATE session_inbox
     SET next_attempt_at = ?
     WHERE target_session_id = ?
       AND delivery_state IN ('queued', 'retry_wait')
       AND (next_attempt_at IS NULL OR next_attempt_at > ?)`,
    now,
    targetSessionId,
    now
  ).rowsWritten;
  return Math.max(released, preparing + queued);
}

export function computePromptDeliveryAlarmTime(
  sql: SqlStorage,
  config: DurableExecutionConfig,
  now = Date.now()
): number | null {
  const row = sql.exec(PROMPT_DELIVERY_ALARM_SQL, config.receiptTimeoutMs).toArray()[0];
  const dueAt = typeof row?.due_at === 'number' ? row.due_at : null;
  if (dueAt === null) return null;
  return Math.max(dueAt, now + config.minAlarmDelayMs);
}
