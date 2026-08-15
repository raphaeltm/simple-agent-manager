import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Attention marker row schemas
// =============================================================================

const AttentionMarkerRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  task_id: v.nullable(v.string()),
  workspace_id: v.nullable(v.string()),
  kind: v.string(),
  source: v.string(),
  source_event_id: v.nullable(v.string()),
  source_message_id: v.nullable(v.string()),
  source_notification_id: v.nullable(v.string()),
  reason: v.nullable(v.string()),
  metadata: v.nullable(v.string()),
  created_at: v.number(),
  expires_at: v.nullable(v.number()),
  resolved_at: v.nullable(v.number()),
  resolved_by_message_id: v.nullable(v.string()),
  resolved_by_actor_type: v.nullable(v.string()),
  resolved_reason: v.nullable(v.string()),
  notification_user_id: v.nullable(v.string()),
  next_escalation_at: v.nullable(v.number()),
  escalation_count: v.number(),
  max_expires_at: v.nullable(v.number()),
  resolved_answer: v.nullable(v.string()),
});

export function parseAttentionMarkerRow(row: unknown): {
  id: string;
  sessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  kind: string;
  source: string;
  sourceEventId: string | null;
  sourceMessageId: string | null;
  sourceNotificationId: string | null;
  reason: string | null;
  metadata: string | null;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
  resolvedByMessageId: string | null;
  resolvedByActorType: string | null;
  resolvedReason: string | null;
  notificationUserId: string | null;
  nextEscalationAt: number | null;
  escalationCount: number;
  maxExpiresAt: number | null;
  resolvedAnswer: string | null;
} {
  const r = parseRow(AttentionMarkerRowSchema, row, 'attention_marker');
  return {
    id: r.id,
    sessionId: r.session_id,
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    source: r.source,
    sourceEventId: r.source_event_id,
    sourceMessageId: r.source_message_id,
    sourceNotificationId: r.source_notification_id,
    reason: r.reason,
    metadata: r.metadata,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
    resolvedByMessageId: r.resolved_by_message_id,
    resolvedByActorType: r.resolved_by_actor_type,
    resolvedReason: r.resolved_reason,
    notificationUserId: r.notification_user_id,
    nextEscalationAt: r.next_escalation_at,
    escalationCount: r.escalation_count,
    maxExpiresAt: r.max_expires_at,
    resolvedAnswer: r.resolved_answer,
  };
}

/** Lightweight summary for session list enrichment */
const AttentionSummaryRowSchema = v.object({
  id: v.string(),
  kind: v.string(),
  created_at: v.number(),
  expires_at: v.nullable(v.number()),
  reason: v.nullable(v.string()),
  metadata: v.nullable(v.string()),
});

export function parseAttentionSummaryRow(row: unknown): {
  markerId: string;
  kind: string;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
  metadata: string | null;
} {
  const r = parseRow(AttentionSummaryRowSchema, row, 'attention_summary');
  return {
    markerId: r.id,
    kind: r.kind,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    reason: r.reason,
    metadata: r.metadata,
  };
}

/** Expiry row — minimal fields for batch processing */
const AttentionExpiryRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  task_id: v.nullable(v.string()),
  workspace_id: v.nullable(v.string()),
  kind: v.string(),
  source_notification_id: v.nullable(v.string()),
  notification_user_id: v.nullable(v.string()),
  created_at: v.number(),
  expires_at: v.nullable(v.number()),
  next_escalation_at: v.nullable(v.number()),
  escalation_count: v.number(),
  max_expires_at: v.nullable(v.number()),
});

export function parseAttentionExpiryRow(row: unknown): {
  id: string;
  sessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  kind: string;
  sourceNotificationId: string | null;
  notificationUserId: string | null;
  createdAt: number;
  expiresAt: number | null;
  nextEscalationAt: number | null;
  escalationCount: number;
  maxExpiresAt: number | null;
} {
  const r = parseRow(AttentionExpiryRowSchema, row, 'attention_expiry');
  return {
    id: r.id,
    sessionId: r.session_id,
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    sourceNotificationId: r.source_notification_id,
    notificationUserId: r.notification_user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    nextEscalationAt: r.next_escalation_at,
    escalationCount: r.escalation_count,
    maxExpiresAt: r.max_expires_at,
  };
}
