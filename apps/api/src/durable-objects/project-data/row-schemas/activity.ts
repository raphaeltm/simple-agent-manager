import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Idle cleanup row schemas
// =============================================================================

/** Idle cleanup schedule row */
const IdleCleanupScheduleSchema = v.object({
  session_id: v.string(),
  workspace_id: v.string(),
  task_id: v.nullable(v.string()),
  retry_count: v.number(),
});

export function parseIdleCleanupSchedule(row: unknown): {
  sessionId: string;
  workspaceId: string;
  taskId: string | null;
  retryCount: number;
} {
  const r = parseRow(IdleCleanupScheduleSchema, row, 'idle_cleanup_schedule');
  return {
    sessionId: r.session_id,
    workspaceId: r.workspace_id,
    taskId: r.task_id,
    retryCount: r.retry_count,
  };
}

/** Workspace activity row with session join for idle timeout checks */
const WorkspaceActivitySchema = v.object({
  workspace_id: v.string(),
  session_id: v.nullable(v.string()),
  last_terminal_activity_at: v.nullable(v.number()),
  last_message_at: v.nullable(v.number()),
  session_updated_at: v.nullable(v.number()),
});

export function parseWorkspaceActivity(row: unknown): {
  workspaceId: string;
  sessionId: string | null;
  lastTerminalActivityAt: number;
  lastMessageAt: number;
  sessionUpdatedAt: number;
} {
  const r = parseRow(WorkspaceActivitySchema, row, 'workspace_activity');
  return {
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    lastTerminalActivityAt: r.last_terminal_activity_at ?? 0,
    lastMessageAt: r.last_message_at ?? 0,
    sessionUpdatedAt: r.session_updated_at ?? 0,
  };
}

// =============================================================================
// Session–Idea link row schemas
// =============================================================================

/** Idea link row for getIdeasForSession */
const SessionIdeaLinkSchema = v.object({
  task_id: v.string(),
  context: v.nullable(v.string()),
  created_at: v.number(),
});

export function parseSessionIdeaLink(row: unknown): {
  taskId: string;
  context: string | null;
  createdAt: number;
} {
  const r = parseRow(SessionIdeaLinkSchema, row, 'session_idea_link');
  return { taskId: r.task_id, context: r.context, createdAt: r.created_at };
}

/** Idea session detail row for getSessionsForIdea */
const IdeaSessionDetailSchema = v.object({
  session_id: v.string(),
  topic: v.nullable(v.string()),
  status: v.string(),
  context: v.nullable(v.string()),
  created_at: v.number(),
});

export function parseIdeaSessionDetail(row: unknown): {
  sessionId: string;
  topic: string | null;
  status: string;
  context: string | null;
  linkedAt: number;
} {
  const r = parseRow(IdeaSessionDetailSchema, row, 'idea_session_detail');
  return {
    sessionId: r.session_id,
    topic: r.topic,
    status: r.status,
    context: r.context,
    linkedAt: r.created_at,
  };
}

// =============================================================================
// Cached command row schemas
// =============================================================================

const CachedCommandRowSchema = v.object({
  agent_type: v.string(),
  name: v.string(),
  description: v.string(),
  updated_at: v.number(),
});

export function parseCachedCommandRow(row: unknown): {
  agentType: string;
  name: string;
  description: string;
  updatedAt: number;
} {
  const r = parseRow(CachedCommandRowSchema, row, 'cached_command');
  return {
    agentType: r.agent_type,
    name: r.name,
    description: r.description,
    updatedAt: r.updated_at,
  };
}

// =============================================================================
// Activity event row schemas
// =============================================================================

const ActivityEventRowSchema = v.object({
  id: v.string(),
  event_type: v.string(),
  actor_type: v.string(),
  actor_id: v.nullable(v.string()),
  workspace_id: v.nullable(v.string()),
  session_id: v.nullable(v.string()),
  task_id: v.nullable(v.string()),
  payload: v.nullable(v.string()),
  created_at: v.number(),
});

export function parseActivityEventRow(row: unknown): Record<string, unknown> {
  const r = parseRow(ActivityEventRowSchema, row, 'activity_event');
  return {
    id: r.id,
    eventType: r.event_type,
    actorType: r.actor_type,
    actorId: r.actor_id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    taskId: r.task_id,
    payload: r.payload ? JSON.parse(r.payload) : null,
    createdAt: r.created_at,
  };
}
