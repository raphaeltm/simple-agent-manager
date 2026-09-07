import {
  type AgentMailboxMessage,
  DELIVERY_STATES,
  MESSAGE_CLASSES,
  PROMPT_DELIVERY_SOURCES,
  SENDER_TYPES,
  VM_PROMPT_RECEIPT_STATES,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { expectJsonRecord } from '../../../lib/runtime-validation';
import { parseRow, safeParseJson } from './core';

// =============================================================================
// Agent Mailbox row schemas (extended from session_inbox via migration 017)
// =============================================================================


/** Full mailbox message row — includes all columns from migration 015 + 017 */
const MailboxMessageRowSchema = v.object({
  id: v.string(),
  target_session_id: v.string(),
  source_task_id: v.nullable(v.string()),
  message_type: v.string(),
  content: v.string(),
  priority: v.string(),
  created_at: v.number(),
  delivered_at: v.nullable(v.number()),
  // Migration 017 columns
  message_class: v.picklist(MESSAGE_CLASSES),
  delivery_state: v.picklist(DELIVERY_STATES),
  sender_type: v.picklist(SENDER_TYPES),
  sender_id: v.nullable(v.string()),
  ack_required: v.number(),
  acked_at: v.nullable(v.number()),
  ack_timeout_ms: v.nullable(v.number()),
  expires_at: v.nullable(v.number()),
  delivery_attempts: v.number(),
  last_delivery_at: v.nullable(v.number()),
  metadata: v.nullable(v.string()),
  // Migration 026 columns
  source_kind: v.picklist(PROMPT_DELIVERY_SOURCES),
  prompt_message_id: v.nullable(v.string()),
  next_attempt_at: v.nullable(v.number()),
  last_error: v.nullable(v.string()),
  terminal_reason: v.nullable(v.string()),
  attempt_id: v.nullable(v.string()),
  attempt_started_at: v.nullable(v.number()),
  runtime_identity: v.nullable(v.string()),
  receipt_state: v.nullable(v.picklist(VM_PROMPT_RECEIPT_STATES)),
  receipt_runtime_identity: v.nullable(v.string()),
  receipt_checked_at: v.nullable(v.number()),
  accepted_at: v.nullable(v.number()),
  adapter_protocol_version: v.nullable(v.number()),
  receipt_supported: v.nullable(v.number()),
});

export function parseMailboxMessageRow(row: unknown): AgentMailboxMessage {
  const r = parseRow(MailboxMessageRowSchema, row, 'mailbox_message');
  return {
    id: r.id,
    targetSessionId: r.target_session_id,
    sourceTaskId: r.source_task_id,
    senderType: r.sender_type,
    senderId: r.sender_id,
    messageClass: r.message_class,
    deliveryState: r.delivery_state,
    content: r.content,
    metadata: r.metadata ? expectJsonRecord(safeParseJson(r.metadata), 'mailbox_message.metadata') : null,
    ackRequired: r.ack_required === 1,
    ackTimeoutMs: r.ack_timeout_ms,
    deliveryAttempts: r.delivery_attempts,
    lastDeliveryAt: r.last_delivery_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    ackedAt: r.acked_at,
    sourceKind: r.source_kind,
    promptMessageId: r.prompt_message_id ?? r.id,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    terminalReason: r.terminal_reason,
    attemptId: r.attempt_id,
    attemptStartedAt: r.attempt_started_at,
    runtimeIdentity: r.runtime_identity,
    receiptState: r.receipt_state,
    receiptRuntimeIdentity: r.receipt_runtime_identity,
    receiptCheckedAt: r.receipt_checked_at,
    acceptedAt: r.accepted_at,
    adapterProtocolVersion: r.adapter_protocol_version,
    receiptSupported: r.receipt_supported === null ? null : r.receipt_supported === 1,
  };
}

/** Legacy parser kept for backwards compatibility with any code reading old rows */
export function parseInboxMessageRow(row: unknown): {
  id: string;
  targetSessionId: string;
  sourceTaskId: string | null;
  messageType: string;
  content: string;
  priority: string;
  createdAt: number;
  deliveredAt: number | null;
  messageClass: string;
  deliveryState: string;
  senderType: string;
  senderId: string | null;
  ackRequired: boolean;
  ackedAt: number | null;
  ackTimeoutMs: number | null;
  expiresAt: number | null;
  deliveryAttempts: number;
  lastDeliveryAt: number | null;
  metadata: unknown;
} {
  const r = parseRow(MailboxMessageRowSchema, row, 'inbox_message');
  return {
    id: r.id,
    targetSessionId: r.target_session_id,
    sourceTaskId: r.source_task_id,
    messageType: r.message_type,
    content: r.content,
    priority: r.priority,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    messageClass: r.message_class,
    deliveryState: r.delivery_state,
    senderType: r.sender_type,
    senderId: r.sender_id,
    ackRequired: r.ack_required === 1,
    ackedAt: r.acked_at,
    ackTimeoutMs: r.ack_timeout_ms,
    expiresAt: r.expires_at,
    deliveryAttempts: r.delivery_attempts,
    lastDeliveryAt: r.last_delivery_at,
    metadata: safeParseJson(r.metadata),
  };
}
