// FILE SIZE EXCEPTION: Schema/type definition file — splitting schemas across files creates import complexity. See .claude/rules/18-file-size-limits.md
/**
 * Valibot schemas and validated mappers for DO SQLite row parsing.
 *
 * Replaces raw `as string` / `as number` casts with runtime validation.
 * Each schema matches the column names returned by SQLite (snake_case).
 * Mapper functions validate and transform to camelCase TypeScript types.
 */
import type { AcpSession } from '@simple-agent-manager/shared';
import * as v from 'valibot';

// =============================================================================
// Generic parse helpers
// =============================================================================

/**
 * Parse a single row with a Valibot schema; throw a descriptive error on failure.
 */
export function parseRow<TOutput>(
  schema: v.GenericSchema<unknown, TOutput>,
  row: unknown,
  context: string
): TOutput {
  const result = v.safeParse(schema, row);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const path = issue.path?.map((p) => p.key).join('.') || 'root';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Row validation failed (${context}): ${issues}`);
  }
  return result.output;
}

/** Safely parse a JSON string, returning null on failure. */
function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// =============================================================================
// Aggregate / utility row schemas
// =============================================================================

/** COUNT(*) as cnt */
const CountCntRowSchema = v.object({ cnt: v.number() });

export function parseCountCnt(row: unknown, context: string): number {
  return parseRow(CountCntRowSchema, row, context).cnt;
}

/** COUNT(*) as count */
const CountRowSchema = v.object({ count: v.number() });

export function parseCount(row: unknown, context: string): number {
  return parseRow(CountRowSchema, row, context).count;
}

/** MAX(sequence) / MAX(something) as max_seq */
const MaxSeqRowSchema = v.object({ max_seq: v.number() });

export function parseMaxSeq(row: unknown, context: string): number {
  return parseRow(MaxSeqRowSchema, row, context).max_seq;
}

/** MIN(something) as earliest — nullable aggregate */
const MinEarliestRowSchema = v.object({ earliest: v.nullable(v.number()) });

export function parseMinEarliest(row: unknown, context: string): number | null {
  return parseRow(MinEarliestRowSchema, row, context).earliest;
}

/** MAX(created_at) as latest — nullable aggregate (used in index.ts) */
const MaxLatestRowSchema = v.object({ latest: v.nullable(v.number()) });

export function parseMaxLatest(row: unknown, context: string): number | null {
  return parseRow(MaxLatestRowSchema, row, context).latest;
}

/** Single-column message_count read */
const MessageCountRowSchema = v.object({ message_count: v.number() });

export function parseMessageCount(row: unknown, context: string): number {
  return parseRow(MessageCountRowSchema, row, context).message_count;
}

/** Single-column workspace_id nullable read */
const WorkspaceIdRowSchema = v.object({ workspace_id: v.nullable(v.string()) });

export function parseWorkspaceId(row: unknown, context: string): string | null {
  return parseRow(WorkspaceIdRowSchema, row, context).workspace_id;
}

/** Single-column enabled boolean (stored as 0/1 integer) */
const EnabledRowSchema = v.object({ enabled: v.number() });

export function parseEnabled(row: unknown, context: string): boolean {
  return parseRow(EnabledRowSchema, row, context).enabled === 1;
}

/** Single-column cleanup_at read */
const CleanupAtRowSchema = v.object({ cleanup_at: v.number() });

export function parseCleanupAt(row: unknown, context: string): number {
  return parseRow(CleanupAtRowSchema, row, context).cleanup_at;
}

// =============================================================================
// ACP Session row schemas
// =============================================================================

const AcpSessionStatusSchema = v.picklist([
  'pending',
  'assigned',
  'running',
  'completed',
  'failed',
  'interrupted',
]);

/** Full ACP session row from SELECT * */
export const AcpSessionRowSchema = v.object({
  id: v.string(),
  chat_session_id: v.string(),
  workspace_id: v.nullable(v.string()),
  node_id: v.nullable(v.string()),
  status: AcpSessionStatusSchema,
  agent_type: v.nullable(v.string()),
  initial_prompt: v.nullable(v.string()),
  parent_session_id: v.nullable(v.string()),
  fork_depth: v.number(),
  acp_sdk_session_id: v.nullable(v.string()),
  error_message: v.nullable(v.string()),
  last_heartbeat_at: v.nullable(v.number()),
  assigned_at: v.nullable(v.number()),
  started_at: v.nullable(v.number()),
  completed_at: v.nullable(v.number()),
  interrupted_at: v.nullable(v.number()),
  created_at: v.number(),
  updated_at: v.number(),
});

export function parseAcpSessionRow(row: unknown): AcpSession {
  const r = parseRow(AcpSessionRowSchema, row, 'acp_session');
  return {
    id: r.id,
    chatSessionId: r.chat_session_id,
    workspaceId: r.workspace_id,
    nodeId: r.node_id,
    status: r.status,
    agentType: r.agent_type,
    initialPrompt: r.initial_prompt,
    parentSessionId: r.parent_session_id,
    forkDepth: r.fork_depth,
    acpSdkSessionId: r.acp_sdk_session_id,
    errorMessage: r.error_message,
    lastHeartbeatAt: r.last_heartbeat_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    assignedAt: r.assigned_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    interruptedAt: r.interrupted_at,
  };
}

/** Partial ACP session for heartbeat checks: id, node_id, status */
const AcpSessionHeartbeatCheckSchema = v.object({
  id: v.string(),
  node_id: v.nullable(v.string()),
  status: v.string(),
});

export function parseAcpSessionHeartbeatCheck(row: unknown): {
  id: string;
  nodeId: string | null;
  status: string;
} {
  const r = parseRow(AcpSessionHeartbeatCheckSchema, row, 'acp_session_heartbeat_check');
  return { id: r.id, nodeId: r.node_id, status: r.status };
}

/** Partial ACP session for lineage traversal: id, parent_session_id */
const AcpSessionLineageSchema = v.object({
  id: v.string(),
  parent_session_id: v.nullable(v.string()),
});

export function parseAcpSessionLineage(row: unknown): {
  id: string;
  parentSessionId: string | null;
} {
  const r = parseRow(AcpSessionLineageSchema, row, 'acp_session_lineage');
  return { id: r.id, parentSessionId: r.parent_session_id };
}

/** Partial ACP session for heartbeat timeout: id, chat_session_id, workspace_id, node_id, last_heartbeat_at */
const AcpSessionStaleSchema = v.object({
  id: v.string(),
  chat_session_id: v.string(),
  workspace_id: v.nullable(v.string()),
  node_id: v.nullable(v.string()),
  last_heartbeat_at: v.nullable(v.number()),
});

export function parseAcpSessionStale(row: unknown): {
  id: string;
  chatSessionId: string;
  workspaceId: string | null;
  nodeId: string | null;
  lastHeartbeatAt: number | null;
} {
  const r = parseRow(AcpSessionStaleSchema, row, 'acp_session_stale');
  return {
    id: r.id,
    chatSessionId: r.chat_session_id,
    workspaceId: r.workspace_id,
    nodeId: r.node_id,
    lastHeartbeatAt: r.last_heartbeat_at,
  };
}

// =============================================================================
// Chat message row schemas
// =============================================================================

/** Full chat message row from SELECT queries */
const ChatMessageRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  role: v.string(),
  content: v.string(),
  tool_metadata: v.nullable(v.string()),
  created_at: v.number(),
  sequence: v.nullable(v.number()),
});

export function parseChatMessageRow(row: unknown): {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: unknown;
  createdAt: number;
  sequence: number | null;
} {
  const r = parseRow(ChatMessageRowSchema, row, 'chat_message');
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    toolMetadata: r.tool_metadata ? JSON.parse(r.tool_metadata) : null,
    createdAt: r.created_at,
    sequence: r.sequence,
  };
}

/** Search result row (message + session join) */
const SearchResultRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  role: v.string(),
  content: v.string(),
  created_at: v.number(),
  session_topic: v.nullable(v.string()),
  session_task_id: v.nullable(v.string()),
});

export type SearchResultParsed = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

export function parseSearchResultRow(row: unknown): SearchResultParsed {
  const r = parseRow(SearchResultRowSchema, row, 'search_result');
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    sessionTopic: r.session_topic,
    sessionTaskId: r.session_task_id,
  };
}

// =============================================================================
// Chat session row schemas
// =============================================================================

/** Session listing row (includes optional cleanup_at from LEFT JOIN) */
const ChatSessionListRowSchema = v.object({
  id: v.string(),
  workspace_id: v.nullable(v.string()),
  task_id: v.nullable(v.string()),
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
    topic: r.topic,
    status,
    messageCount: r.message_count,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    agentCompletedAt,
    lastMessageAt: r.updated_at,
    isIdle: status === 'active' && agentCompletedAt != null,
    isTerminated: status === 'stopped',
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

// =============================================================================
// Materialization row schemas
// =============================================================================

/** Session materialization check: materialized_at, status */
const MaterializationCheckSchema = v.object({
  materialized_at: v.nullable(v.number()),
  status: v.string(),
});

export function parseMaterializationCheck(row: unknown): {
  materializedAt: number | null;
  status: string;
} {
  const r = parseRow(MaterializationCheckSchema, row, 'materialization_check');
  return { materializedAt: r.materialized_at, status: r.status };
}

/** Raw message token for materialization grouping */
const MaterializationTokenSchema = v.object({
  id: v.string(),
  role: v.string(),
  content: v.string(),
  created_at: v.number(),
});

export function parseMaterializationToken(row: unknown): {
  id: string;
  role: string;
  content: string;
  createdAt: number;
} {
  const r = parseRow(MaterializationTokenSchema, row, 'materialization_token');
  return { id: r.id, role: r.role, content: r.content, createdAt: r.created_at };
}

/** Grouped message rowid lookup */
const RowidSchema = v.object({ rowid: v.number() });

export function parseRowid(row: unknown, context: string): number {
  return parseRow(RowidSchema, row, context).rowid;
}

/** Session ID-only row for batch materialization */
const SessionIdSchema = v.object({ id: v.string() });

export function parseSessionId(row: unknown, context: string): string {
  return parseRow(SessionIdSchema, row, context).id;
}

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

// =============================================================================
// Agent Mailbox row schemas (extended from session_inbox via migration 017)
// =============================================================================

import type { AgentMailboxMessage } from '@simple-agent-manager/shared';

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
    metadata: safeParseJson(r.metadata) as Record<string, unknown> | null,
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

// =============================================================================
// Knowledge Graph row schemas
// =============================================================================

const KnowledgeEntityRowSchema = v.object({
  id: v.string(),
  name: v.string(),
  entity_type: v.string(),
  description: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
});

const KnowledgeEntityWithCountSchema = v.object({
  id: v.string(),
  name: v.string(),
  entity_type: v.string(),
  description: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
  observation_count: v.number(),
});

export function parseKnowledgeEntityRow(row: unknown): {
  id: string;
  name: string;
  entityType: string;
  description: string | null;
  observationCount: number;
  createdAt: number;
  updatedAt: number;
} {
  const r = parseRow(KnowledgeEntityWithCountSchema, row, 'knowledge_entity');
  return {
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    description: r.description,
    observationCount: r.observation_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function parseKnowledgeEntityBasicRow(row: unknown): {
  id: string;
  name: string;
  entityType: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
} {
  const r = parseRow(KnowledgeEntityRowSchema, row, 'knowledge_entity_basic');
  return {
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const KnowledgeObservationRowSchema = v.object({
  id: v.string(),
  entity_id: v.string(),
  content: v.string(),
  confidence: v.number(),
  source_type: v.string(),
  source_session_id: v.nullable(v.string()),
  created_at: v.number(),
  last_confirmed_at: v.number(),
  superseded_by: v.nullable(v.string()),
  is_active: v.number(),
});

export function parseKnowledgeObservationRow(row: unknown): {
  id: string;
  entityId: string;
  content: string;
  confidence: number;
  sourceType: string;
  sourceSessionId: string | null;
  createdAt: number;
  lastConfirmedAt: number;
  supersededBy: string | null;
  isActive: boolean;
} {
  const r = parseRow(KnowledgeObservationRowSchema, row, 'knowledge_observation');
  return {
    id: r.id,
    entityId: r.entity_id,
    content: r.content,
    confidence: r.confidence,
    sourceType: r.source_type,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    lastConfirmedAt: r.last_confirmed_at,
    supersededBy: r.superseded_by,
    isActive: r.is_active === 1,
  };
}

const KnowledgeObservationSearchSchema = v.object({
  id: v.string(),
  entity_id: v.string(),
  content: v.string(),
  confidence: v.number(),
  source_type: v.string(),
  source_session_id: v.nullable(v.string()),
  created_at: v.number(),
  last_confirmed_at: v.number(),
  superseded_by: v.nullable(v.string()),
  is_active: v.number(),
  entity_name: v.string(),
  entity_type: v.string(),
});

export function parseKnowledgeObservationSearchRow(row: unknown): {
  id: string;
  entityId: string;
  content: string;
  confidence: number;
  sourceType: string;
  sourceSessionId: string | null;
  createdAt: number;
  lastConfirmedAt: number;
  supersededBy: string | null;
  isActive: boolean;
  entityName: string;
  entityType: string;
} {
  const r = parseRow(KnowledgeObservationSearchSchema, row, 'knowledge_observation_search');
  return {
    id: r.id,
    entityId: r.entity_id,
    content: r.content,
    confidence: r.confidence,
    sourceType: r.source_type,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    lastConfirmedAt: r.last_confirmed_at,
    supersededBy: r.superseded_by,
    isActive: r.is_active === 1,
    entityName: r.entity_name,
    entityType: r.entity_type,
  };
}

const KnowledgeRelationRowSchema = v.object({
  id: v.string(),
  source_entity_id: v.string(),
  target_entity_id: v.string(),
  relation_type: v.string(),
  description: v.nullable(v.string()),
  created_at: v.number(),
});

export function parseKnowledgeRelationRow(row: unknown): {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  description: string | null;
  createdAt: number;
} {
  const r = parseRow(KnowledgeRelationRowSchema, row, 'knowledge_relation');
  return {
    id: r.id,
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    relationType: r.relation_type,
    description: r.description,
    createdAt: r.created_at,
  };
}

// =============================================================================
// Migration row schema
// =============================================================================

const MigrationNameSchema = v.object({ name: v.string() });

export function parseMigrationName(row: unknown): string {
  return parseRow(MigrationNameSchema, row, 'migration_name').name;
}

// =============================================================================
// KV meta row schema (used in index.ts for do_meta)
// =============================================================================

const MetaValueSchema = v.object({ value: v.string() });

export function parseMetaValue(row: unknown, context: string): string {
  return parseRow(MetaValueSchema, row, context).value;
}

// =============================================================================
// Mission state entry row schema
// =============================================================================

const MissionStateEntryRowSchema = v.object({
  id: v.string(),
  mission_id: v.string(),
  entry_type: v.string(),
  title: v.string(),
  content: v.nullable(v.string()),
  source_task_id: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
});

export function parseMissionStateEntryRow(row: unknown) {
  const r = parseRow(MissionStateEntryRowSchema, row, 'mission_state_entry');
  return {
    id: r.id,
    missionId: r.mission_id,
    entryType: r.entry_type,
    title: r.title,
    content: r.content,
    sourceTaskId: r.source_task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// =============================================================================
// Handoff packet row schema
// =============================================================================

const HandoffPacketRowSchema = v.object({
  id: v.string(),
  mission_id: v.string(),
  from_task_id: v.string(),
  to_task_id: v.nullable(v.string()),
  summary: v.string(),
  facts: v.nullable(v.string()),
  open_questions: v.nullable(v.string()),
  artifact_refs: v.nullable(v.string()),
  suggested_actions: v.nullable(v.string()),
  created_at: v.number(),
});

export function parseHandoffPacketRow(row: unknown) {
  const r = parseRow(HandoffPacketRowSchema, row, 'handoff_packet');
  return {
    id: r.id,
    missionId: r.mission_id,
    fromTaskId: r.from_task_id,
    toTaskId: r.to_task_id,
    summary: r.summary,
    facts: r.facts ? JSON.parse(r.facts) : [],
    openQuestions: r.open_questions ? JSON.parse(r.open_questions) : [],
    artifactRefs: r.artifact_refs ? JSON.parse(r.artifact_refs) : [],
    suggestedActions: r.suggested_actions ? JSON.parse(r.suggested_actions) : [],
    createdAt: r.created_at,
  };
}
