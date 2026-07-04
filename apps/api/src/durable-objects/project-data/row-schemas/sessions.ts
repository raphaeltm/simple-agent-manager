import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Chat session row schemas
// =============================================================================

/** Session listing row (includes optional cleanup_at from LEFT JOIN) */
const ChatSessionListRowSchema = v.object({
  id: v.string(),
  workspace_id: v.nullable(v.string()),
  task_id: v.nullable(v.string()),
  created_by_user_id: v.optional(v.nullable(v.string())),
  topic: v.nullable(v.string()),
  status: v.string(),
  message_count: v.number(),
  started_at: v.number(),
  ended_at: v.nullable(v.number()),
  created_at: v.number(),
  updated_at: v.number(),
  agent_completed_at: v.nullable(v.number()),
  // Optional: from LEFT JOIN idle_cleanup_schedule
  cleanup_at: v.optional(v.nullable(v.number())),
});

export function parseChatSessionListRow(row: unknown): Record<string, unknown> {
  const r = parseRow(ChatSessionListRowSchema, row, 'chat_session');
  const status = r.status;
  const agentCompletedAt = r.agent_completed_at;
  const workspaceId = r.workspace_id;

  return {
    id: r.id,
    workspaceId,
    taskId: r.task_id,
    createdByUserId: r.created_by_user_id ?? null,
    topic: r.topic,
    status,
    messageCount: r.message_count,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    agentCompletedAt,
    lastMessageAt: r.updated_at,
    isIdle: status === 'active' && agentCompletedAt != null,
    isTerminated: status === 'stopped' || status === 'failed',
    workspaceUrl: null, // populated by addBaseDomain in index.ts
    cleanupAt: r.cleanup_at ?? null,
  };
}

/** Partial session row for stop: workspace_id, message_count */
const SessionStopSchema = v.object({
  workspace_id: v.nullable(v.string()),
  message_count: v.number(),
});

export function parseSessionStop(row: unknown): {
  workspaceId: string | null;
  messageCount: number;
} {
  const r = parseRow(SessionStopSchema, row, 'session_stop');
  return { workspaceId: r.workspace_id, messageCount: r.message_count };
}

/** Partial session row for status check */
const SessionStatusSchema = v.object({
  id: v.string(),
  status: v.string(),
});

export function parseSessionStatus(row: unknown): { id: string; status: string } {
  return parseRow(SessionStatusSchema, row, 'session_status');
}
