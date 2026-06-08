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
  };
}

/** Lightweight summary for session list enrichment */
const AttentionSummaryRowSchema = v.object({
  kind: v.string(),
  created_at: v.number(),
  expires_at: v.nullable(v.number()),
  reason: v.nullable(v.string()),
});

export function parseAttentionSummaryRow(row: unknown): {
  kind: string;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
} {
  const r = parseRow(AttentionSummaryRowSchema, row, 'attention_summary');
  return {
    kind: r.kind,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    reason: r.reason,
  };
}

/** Expiry row — minimal fields for batch processing */
const AttentionExpiryRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  task_id: v.nullable(v.string()),
  workspace_id: v.nullable(v.string()),
  kind: v.string(),
});

export function parseAttentionExpiryRow(row: unknown): {
  id: string;
  sessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  kind: string;
} {
  const r = parseRow(AttentionExpiryRowSchema, row, 'attention_expiry');
  return {
    id: r.id,
    sessionId: r.session_id,
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
  };
}
