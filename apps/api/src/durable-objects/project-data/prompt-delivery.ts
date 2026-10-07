import type {
  AgentMailboxMessage,
  MessageClass,
  PromptDeliverySource,
  SenderType,
  VmPromptDeliveryCapabilities,
  VmPromptDeliveryReceipt,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import type { DurableExecutionConfig } from './durable-execution-config';
import { promptDeliveryBackoffMs } from './durable-execution-config';
import * as mailbox from './mailbox';
import * as messages from './messages';
import { parseMailboxMessageRow } from './row-schemas';
import type { Env } from './types';

const log = createModuleLogger('project_data.prompt_delivery');
const MAX_DELIVERY_ERROR_LENGTH = 2048;

function boundedError(value: string): string {
  return value.trim().slice(0, MAX_DELIVERY_ERROR_LENGTH) || 'Unknown prompt delivery error';
}

export interface AcceptPromptDeliveryInput {
  deliveryId?: string;
  targetSessionId: string;
  displayContent: string;
  deliveryContent?: string;
  sourceTaskId?: string | null;
  senderType: SenderType;
  senderId?: string | null;
  messageClass?: MessageClass;
  sourceKind: PromptDeliverySource;
  metadata?: Record<string, unknown> | null;
  ackTimeoutMs?: number | null;
  ttlMs?: number | null;
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
  const displayContent = input.displayContent.trim();
  const deliveryContent = (input.deliveryContent ?? input.displayContent).trim();
  if (!targetSessionId) throw new Error('targetSessionId is required');
  if (!displayContent || !deliveryContent) throw new Error('prompt content is required');

  const existing = input.deliveryId ? mailbox.getMessage(sql, input.deliveryId) : null;
  if (existing) {
    if (
      existing.targetSessionId !== targetSessionId ||
      existing.sourceKind !== input.sourceKind ||
      existing.content !== deliveryContent
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
  const toolMetadata = JSON.stringify({
    ...(input.metadata ?? {}),
    source: input.sourceKind,
    kind: 'durable_prompt_delivery',
    deliveryId,
  });
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
    maxMessages: input.maxMessages,
    sourceKind: input.sourceKind,
    promptMessageId: persisted.id,
    now,
    ackRequired: false,
    durableDelivery: true,
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
    `UPDATE session_inbox
     SET delivery_state = 'expired',
         terminal_reason = 'ttl_expired',
         last_error = COALESCE(last_error, 'Prompt delivery TTL expired')
     WHERE delivery_state IN ('queued', 'retry_wait', 'delivering')
       AND expires_at IS NOT NULL
       AND expires_at <= ?`,
    now
  ).rowsWritten;
  const failed = sql.exec(
    `UPDATE session_inbox
     SET delivery_state = 'failed',
         terminal_reason = 'max_attempts_exceeded',
         last_error = COALESCE(last_error, 'Prompt delivery maximum attempts exceeded')
     WHERE delivery_state IN ('queued', 'retry_wait')
       AND delivery_attempts >= ?`,
    config.maxAttempts
  ).rowsWritten;
  return { expired, failed, expiredWakeFailures };
}

export interface ExpiredWakeDelivery {
  deliveryId: string;
  targetSessionId: string;
  sourceTaskId: string | null;
  lastError: string | null;
  terminalReason: string;
}

function listExpiringWakeDeliveries(sql: SqlStorage, now: number): ExpiredWakeDelivery[] {
  return sql
    .exec(
      `SELECT inbox.id AS delivery_id,
              inbox.target_session_id,
              inbox.source_task_id,
              inbox.last_error,
              'ttl_expired' AS terminal_reason
         FROM session_inbox inbox
         JOIN chat_sessions session ON session.id = inbox.target_session_id
        WHERE inbox.delivery_state IN ('queued', 'retry_wait', 'delivering')
          AND inbox.expires_at IS NOT NULL
          AND inbox.expires_at <= ?
          AND inbox.source_kind IN ('user_followup', 'parent_wakeup', 'project_event_wake', 'scheduled_action')
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
  return `CASE ${alias}.message_class
    WHEN 'shutdown_with_final_prompt' THEN 5 WHEN 'preempt_and_replan' THEN 4
    WHEN 'interrupt' THEN 3 WHEN 'deliver' THEN 2 WHEN 'notify' THEN 1 ELSE 0 END`;
}

function noEarlierDeliverySql(): string {
  const activePriority = deliveryPrioritySql('active');
  const inboxPriority = deliveryPrioritySql('inbox');
  return `NOT EXISTS (SELECT 1 FROM session_inbox active
    WHERE active.target_session_id = inbox.target_session_id AND active.id != inbox.id
      AND (active.delivery_state = 'delivering' OR (
        active.delivery_state IN ('queued', 'retry_wait') AND (
          ${activePriority} > ${inboxPriority} OR (
            ${activePriority} = ${inboxPriority} AND (
              active.created_at < inbox.created_at OR
              (active.created_at = inbox.created_at AND active.rowid < inbox.rowid)
            )
          )
        )
      )))`;
}

// Built once from module-owned SQL fragments; caller values remain bound parameters.
const CLAIM_DUE_PROMPT_DELIVERIES_SQL = `SELECT * FROM session_inbox inbox
     WHERE (
       delivery_state IN ('queued', 'retry_wait')
       AND COALESCE(next_attempt_at, created_at) <= ?
       AND delivery_attempts < ?
       AND ${noEarlierDeliverySql()}
     ) OR (
       delivery_state = 'delivering'
       AND attempt_started_at IS NOT NULL
       AND attempt_started_at <= ?
     )
     ORDER BY
       CASE message_class
         WHEN 'shutdown_with_final_prompt' THEN 5
         WHEN 'preempt_and_replan' THEN 4
         WHEN 'interrupt' THEN 3
         WHEN 'deliver' THEN 2
         WHEN 'notify' THEN 1
         ELSE 0
       END DESC,
       created_at ASC,
       rowid ASC
     LIMIT ?`;
// Built once from module-owned SQL fragments; caller values remain bound parameters.
const PROMPT_DELIVERY_ALARM_SQL = `SELECT MIN(due_at) AS due_at FROM (
       SELECT MIN(COALESCE(next_attempt_at, created_at)) AS due_at
       FROM session_inbox inbox
       WHERE delivery_state IN ('queued', 'retry_wait')
         AND ${noEarlierDeliverySql()}
       UNION ALL
       SELECT MIN(attempt_started_at + ?) AS due_at
       FROM session_inbox
       WHERE delivery_state = 'delivering' AND attempt_started_at IS NOT NULL
       UNION ALL
       SELECT MIN(expires_at) AS due_at
       FROM session_inbox
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
      staleBefore,
      config.maxCandidatesPerAlarm
    )
    .toArray();

  const claims: PromptDeliveryClaim[] = [];
  const claimedTargets = new Set<string>();
  for (const row of rows) {
    if (claimedTargets.has(String(row.target_session_id))) continue;
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
      claimedTargets.add(claimed.targetSessionId);
      claims.push({ message: claimed, attemptId, mode });
    }
  }
  return claims;
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

export interface AcceptedDeliveryResult {
  kind: 'accepted';
  acpSessionId: string;
  promptEpoch: number;
  runtimeIdentity: string;
  capabilities: VmPromptDeliveryCapabilities;
  receipt: VmPromptDeliveryReceipt | null;
}

export type PromptDeliveryResult =
  | AcceptedDeliveryResult
  | {
      kind: 'retry';
      reason: 'busy' | 'not_ready' | 'receipt_not_found';
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
    }
  | {
      kind: 'failed';
      reason:
        | 'terminal_target'
        | 'dead_target'
        | 'wake_refused'
        | 'unsupported_capability'
        | 'delivery_conflict';
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
    }
  | {
      kind: 'ambiguous';
      reason: 'lost_response' | 'runtime_changed' | 'receipt_unavailable';
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
      receipt: VmPromptDeliveryReceipt | null;
    };

function capabilitiesColumns(capabilities: VmPromptDeliveryCapabilities | null): {
  protocolVersion: number | null;
  receiptSupported: number | null;
} {
  return {
    protocolVersion: capabilities?.protocolVersion ?? null,
    receiptSupported: capabilities ? (capabilities.promptReceipts.supported ? 1 : 0) : null,
  };
}

export function applyPromptDeliveryResult(
  sql: SqlStorage,
  claim: PromptDeliveryClaim,
  result: PromptDeliveryResult,
  config: DurableExecutionConfig,
  now = Date.now()
): boolean {
  const capability = capabilitiesColumns(result.capabilities);
  if (result.kind === 'accepted') {
    return (
      sql.exec(
        `UPDATE session_inbox
       SET delivery_state = CASE WHEN ack_required = 1 THEN 'delivered' ELSE 'acked' END,
           delivered_at = COALESCE(delivered_at, ?),
           acked_at = CASE WHEN ack_required = 0 THEN COALESCE(acked_at, ?) ELSE acked_at END,
           accepted_at = COALESCE(accepted_at, ?),
           next_attempt_at = NULL,
           last_error = NULL,
           terminal_reason = NULL,
           runtime_identity = ?,
           receipt_state = ?,
           receipt_runtime_identity = ?,
           receipt_checked_at = ?,
           adapter_protocol_version = ?,
           receipt_supported = ?
       WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
        now,
        now,
        result.promptEpoch,
        result.runtimeIdentity,
        result.receipt?.state ?? 'accepted',
        result.receipt?.runtimeIdentity ?? result.runtimeIdentity,
        now,
        capability.protocolVersion,
        capability.receiptSupported,
        claim.message.id,
        claim.attemptId
      ).rowsWritten > 0
    );
  }

  if (result.kind === 'retry') {
    const nextAttemptAt =
      now + promptDeliveryBackoffMs(Math.max(1, claim.message.deliveryAttempts), config);
    // A retry result means the target is alive but temporarily unavailable
    // (for example, a replacement VM is still installing/loading its agent).
    // Do not let that readiness wait become a permanent max-attempts failure:
    // retain the capped attempt ordinal for backoff, while the delivery TTL
    // remains the hard bound. Rows stranded at the cap without an applied
    // result are still failed by expireDuePromptDeliveries above.
    const retryAttemptOrdinal = Math.max(0, config.maxAttempts - 1);
    return (
      sql.exec(
        `UPDATE session_inbox
       SET delivery_state = 'retry_wait',
           delivery_attempts = MIN(delivery_attempts, ?),
           next_attempt_at = CASE WHEN wake_ready_attempt_id = attempt_id
             AND prompt_delivery_phase = 'preparing' AND ? = 'not_ready' THEN ? ELSE ? END,
           wake_ready_attempt_id = NULL,
           last_error = ?,
           runtime_identity = COALESCE(?, runtime_identity),
           adapter_protocol_version = ?,
           receipt_supported = ?
       WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
        retryAttemptOrdinal,
        result.reason,
        now,
        nextAttemptAt,
        boundedError(result.error),
        result.runtimeIdentity,
        capability.protocolVersion,
        capability.receiptSupported,
        claim.message.id,
        claim.attemptId
      ).rowsWritten > 0
    );
  }

  const state = result.kind === 'failed' ? 'failed' : 'ambiguous';
  return (
    sql.exec(
      `UPDATE session_inbox
     SET delivery_state = ?,
         terminal_reason = ?,
         last_error = ?,
         next_attempt_at = NULL,
         runtime_identity = COALESCE(?, runtime_identity),
         receipt_state = ?,
         receipt_runtime_identity = ?,
         receipt_checked_at = ?,
         adapter_protocol_version = ?,
         receipt_supported = ?
     WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
      state,
      result.reason,
      boundedError(result.error),
      result.runtimeIdentity,
      result.kind === 'ambiguous' ? (result.receipt?.state ?? 'ambiguous') : null,
      result.kind === 'ambiguous' ? (result.receipt?.runtimeIdentity ?? null) : null,
      result.kind === 'ambiguous' ? now : null,
      capability.protocolVersion,
      capability.receiptSupported,
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
  return sql.exec(
    `UPDATE session_inbox
     SET next_attempt_at = ?
     WHERE target_session_id = ?
       AND delivery_state IN ('queued', 'retry_wait')
       AND (next_attempt_at IS NULL OR next_attempt_at > ?)`,
    now,
    targetSessionId,
    now
  ).rowsWritten;
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
