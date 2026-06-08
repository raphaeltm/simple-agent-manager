import type { AgentMailboxMessage } from '@simple-agent-manager/shared';
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
  message_class: v.string(),
  delivery_state: v.string(),
  sender_type: v.string(),
  sender_id: v.nullable(v.string()),
  ack_required: v.number(),
  acked_at: v.nullable(v.number()),
  ack_timeout_ms: v.nullable(v.number()),
  expires_at: v.nullable(v.number()),
  delivery_attempts: v.number(),
  last_delivery_at: v.nullable(v.number()),
  metadata: v.nullable(v.string()),
});

export function parseMailboxMessageRow(row: unknown): AgentMailboxMessage {
  const r = parseRow(MailboxMessageRowSchema, row, 'mailbox_message');
  return {
    id: r.id,
    targetSessionId: r.target_session_id,
    sourceTaskId: r.source_task_id,
    senderType: r.sender_type as AgentMailboxMessage['senderType'],
    senderId: r.sender_id,
    messageClass: r.message_class as AgentMailboxMessage['messageClass'],
    deliveryState: r.delivery_state as AgentMailboxMessage['deliveryState'],
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
