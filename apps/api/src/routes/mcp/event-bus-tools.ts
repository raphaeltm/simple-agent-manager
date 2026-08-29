import type {
  AcknowledgeEventBusDeliveryInput,
  EventBusIdentity,
  ListEventBusSubscriptionEventsInput,
  SamEventBusAckResult,
  SamEventBusEventListResult,
  SamEventBusEventSummary,
} from '../../durable-objects/project-data/event-bus';
import {
  EventBusAckPolicyError,
  EventBusAckStateError,
  EventBusCursorError,
} from '../../durable-objects/project-data/event-bus';
import {
  decodeEventBusCursor,
  isEventBusCursorToken,
} from '../../durable-objects/project-data/event-bus-cursors';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';
import {
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

type EventBusToolStorageErrorCode = 'invalid_cursor' | 'ack_not_required' | 'ack_invalid_state';

export class EventBusToolStorageError extends Error {
  constructor(public readonly code: EventBusToolStorageErrorCode) {
    super(code);
    this.name = 'EventBusToolStorageError';
  }
}

export interface EventBusToolStorageAdapter {
  getEventBusEvent: typeof projectDataService.getEventBusEvent;
  listEventBusSubscriptionEvents: typeof projectDataService.listEventBusSubscriptionEvents;
  acknowledgeEventBusDelivery: typeof projectDataService.acknowledgeEventBusDelivery;
}

const defaultStorage: EventBusToolStorageAdapter = projectDataService;

const DERIVED_IDENTITY_FIELDS = new Set([
  'projectId',
  'project_id',
  'userId',
  'user_id',
  'taskId',
  'task_id',
  'sessionId',
  'session_id',
  'chatSessionId',
  'chat_session_id',
  'workspaceId',
  'workspace_id',
  'agentSessionId',
  'agent_session_id',
  'ownerId',
  'owner_id',
  'ownerType',
  'owner_type',
  'targetTaskId',
  'target_task_id',
  'targetSessionId',
  'target_session_id',
  'targetAgentSessionId',
  'target_agent_session_id',
]);
const GET_EVENT_FIELDS = new Set(['eventId']);
const LIST_SUBSCRIPTION_EVENTS_FIELDS = new Set(['subscriptionId', 'limit', 'cursor']);
const ACK_EVENT_DELIVERY_FIELDS = new Set(['deliveryId']);

export async function handleGetEvent(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage: EventBusToolStorageAdapter = defaultStorage
): Promise<JsonRpcResponse> {
  const identityValidation = rejectUnexpectedParams(requestId, params, GET_EVENT_FIELDS);
  if (identityValidation) return identityValidation;

  const eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
  if (!eventId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'eventId is required');
  }

  const identity = await resolveCallerEventBusIdentity(tokenData, env);
  if (!identity) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Caller identity is not valid for this project');
  }

  try {
    const event = await storage.getEventBusEvent(env, tokenData.projectId, eventId, identity);
    if (!event) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Event not found or not visible to this agent'
      );
    }
    return toolJson(requestId, { event });
  } catch (err) {
    log.error('mcp.get_event.failed', {
      projectId: tokenData.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to get event');
  }
}

export async function handleListSubscriptionEvents(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage: EventBusToolStorageAdapter = defaultStorage
): Promise<JsonRpcResponse> {
  const identityValidation = rejectUnexpectedParams(
    requestId,
    params,
    LIST_SUBSCRIPTION_EVENTS_FIELDS
  );
  if (identityValidation) return identityValidation;

  const subscriptionId =
    typeof params.subscriptionId === 'string' ? params.subscriptionId.trim() : '';
  if (!subscriptionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'subscriptionId is required');
  }

  const cursorResult = resolveCursorParam(requestId, params.cursor, subscriptionId, env);
  if ('jsonrpc' in cursorResult) return cursorResult;

  const limitResult = resolveEventBusListLimit(requestId, params.limit, env);
  if ('jsonrpc' in limitResult) return limitResult;

  const identity = await resolveCallerEventBusIdentity(tokenData, env);
  if (!identity) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Caller identity is not valid for this project');
  }

  const input: ListEventBusSubscriptionEventsInput = {
    subscriptionId,
    limit: limitResult.limit,
    cursor: cursorResult.cursor,
  };

  try {
    const result = await storage.listEventBusSubscriptionEvents(
      env,
      tokenData.projectId,
      input,
      identity
    );
    if (!result) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Subscription not found or not visible to this agent'
      );
    }
    return toolJson(requestId, sanitizeListResult(result));
  } catch (err) {
    const domain = classifyEventBusStorageError(err);
    if (domain === 'invalid_cursor') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid cursor');
    }
    log.error('mcp.list_subscription_events.failed', {
      projectId: tokenData.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to list subscription events');
  }
}

export async function handleAckEventDelivery(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage: EventBusToolStorageAdapter = defaultStorage
): Promise<JsonRpcResponse> {
  const identityValidation = rejectUnexpectedParams(requestId, params, ACK_EVENT_DELIVERY_FIELDS);
  if (identityValidation) return identityValidation;

  const deliveryId = typeof params.deliveryId === 'string' ? params.deliveryId.trim() : '';
  if (!deliveryId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'deliveryId is required');
  }

  const identity = await resolveCallerEventBusIdentity(tokenData, env);
  if (!identity) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Caller identity is not valid for this project');
  }

  const input: AcknowledgeEventBusDeliveryInput = { deliveryId };

  try {
    const result = await storage.acknowledgeEventBusDelivery(
      env,
      tokenData.projectId,
      input,
      identity
    );
    if (!result) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Delivery not found or not visible to this agent'
      );
    }
    return toolJson(requestId, sanitizeAckResult(result));
  } catch (err) {
    const domain = classifyEventBusStorageError(err);
    if (domain === 'ack_not_required') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Delivery does not require acknowledgement');
    }
    if (domain === 'ack_invalid_state') {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Delivery cannot be acknowledged in its current state'
      );
    }
    log.error('mcp.ack_event_delivery.failed', {
      projectId: tokenData.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to acknowledge event delivery');
  }
}

async function resolveCallerEventBusIdentity(
  tokenData: McpTokenData,
  env: Env
): Promise<EventBusIdentity | null> {
  let sessionId = tokenData.chatSessionId ?? null;
  const workspaceId = tokenData.workspaceId || null;

  if (tokenData.taskId) {
    const task = await env.DATABASE.prepare(
      'SELECT chat_session_id, workspace_id FROM tasks WHERE id = ? AND project_id = ?'
    )
      .bind(tokenData.taskId, tokenData.projectId)
      .first<{ chat_session_id: string | null; workspace_id: string | null }>();
    if (!task) return null;
    if (!adoptMatchingValue(sessionId, task.chat_session_id)) return null;
    sessionId = task.chat_session_id ?? sessionId;
    if (workspaceId && task.workspace_id && workspaceId !== task.workspace_id) return null;
  }

  if (workspaceId) {
    const workspace = await env.DATABASE.prepare(
      'SELECT chat_session_id FROM workspaces WHERE id = ? AND project_id = ?'
    )
      .bind(workspaceId, tokenData.projectId)
      .first<{ chat_session_id: string | null }>();
    if (!workspace) return null;
    if (!adoptMatchingValue(sessionId, workspace.chat_session_id)) return null;
    sessionId = workspace.chat_session_id ?? sessionId;
  }

  if (tokenData.agentSessionId) {
    const agentSession = await env.DATABASE.prepare(
      `SELECT agent_sessions.id, agent_sessions.workspace_id
       FROM agent_sessions
       INNER JOIN workspaces ON workspaces.id = agent_sessions.workspace_id
       WHERE agent_sessions.id = ? AND workspaces.project_id = ?`
    )
      .bind(tokenData.agentSessionId, tokenData.projectId)
      .first<{ id: string; workspace_id: string }>();
    if (!agentSession) return null;
    if (workspaceId && workspaceId !== agentSession.workspace_id) return null;
  }

  if (!tokenData.taskId && !sessionId && !tokenData.agentSessionId) return null;

  return {
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    taskId: tokenData.taskId || null,
    sessionId,
    workspaceId,
    agentSessionId: tokenData.agentSessionId || null,
  };
}

function adoptMatchingValue(existing: string | null, candidate: string | null): boolean {
  return !existing || !candidate || existing === candidate;
}

function rejectUnexpectedParams(
  requestId: string | number | null,
  params: Record<string, unknown>,
  allowedFields: ReadonlySet<string>
): JsonRpcResponse | null {
  for (const field of Object.keys(params)) {
    if (allowedFields.has(field)) continue;
    if (DERIVED_IDENTITY_FIELDS.has(field)) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Project, user, task, session, workspace, and agent identity are derived from the MCP token'
      );
    }
    return jsonRpcError(requestId, INVALID_PARAMS, `Unexpected parameter: ${field}`);
  }
  return null;
}

function resolveCursorParam(
  requestId: string | number | null,
  raw: unknown,
  subscriptionId: string,
  env: Env
): { cursor: string | null } | JsonRpcResponse {
  if (raw === undefined || raw === null) return { cursor: null };
  if (typeof raw !== 'string') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'cursor must be a string when provided');
  }
  const cursor = raw.trim();
  if (!cursor) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'cursor must be non-empty when provided');
  }
  const cursorMaxLength = getMcpLimits(env).eventBusCursorMaxLength;
  if (!isEventBusCursorToken(cursor, cursorMaxLength)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid cursor');
  }
  try {
    decodeEventBusCursor(cursor, subscriptionId, cursorMaxLength);
  } catch {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid cursor');
  }
  return { cursor };
}

function resolveEventBusListLimit(
  requestId: string | number | null,
  raw: unknown,
  env: Env
): { limit: number } | JsonRpcResponse {
  const limits = getMcpLimits(env);
  if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'limit must be a finite number when provided');
  }
  if (raw !== undefined && !Number.isInteger(raw)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'limit must be an integer when provided');
  }
  const requested = raw === undefined ? limits.eventBusListLimit : raw;
  if (requested <= 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'limit must be greater than 0');
  }
  return {
    limit: Math.min(requested, limits.eventBusListMax),
  };
}

function sanitizeListResult(result: SamEventBusEventListResult): SamEventBusEventListResult {
  return {
    subscriptionId: result.subscriptionId,
    events: result.events.map(sanitizeEventSummary),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  };
}

function sanitizeEventSummary(event: SamEventBusEventSummary): SamEventBusEventSummary {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    source: event.source,
    subject: event.subject,
    actor: event.actor,
    metadata: event.metadata,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    payloadAvailable: true,
    delivery: {
      id: event.delivery.id,
      subscriptionId: event.delivery.subscriptionId,
      state: event.delivery.state,
      policy: event.delivery.policy,
      ackRequired: event.delivery.ackRequired,
      createdAt: event.delivery.createdAt,
      deliveredAt: event.delivery.deliveredAt,
      acknowledgedAt: event.delivery.acknowledgedAt,
    },
  };
}

function sanitizeAckResult(result: SamEventBusAckResult): SamEventBusAckResult {
  return {
    acknowledged: true,
    idempotent: result.idempotent,
    delivery: {
      id: result.delivery.id,
      subscriptionId: result.delivery.subscriptionId,
      eventId: result.delivery.eventId,
      state: result.delivery.state,
      policy: result.delivery.policy,
      ackRequired: result.delivery.ackRequired,
      createdAt: result.delivery.createdAt,
      deliveredAt: result.delivery.deliveredAt,
      acknowledgedAt: result.delivery.acknowledgedAt,
    },
  };
}

function classifyEventBusStorageError(err: unknown): EventBusToolStorageErrorCode | null {
  if (err instanceof EventBusToolStorageError) return err.code;
  if (err instanceof EventBusCursorError) return 'invalid_cursor';
  if (err instanceof EventBusAckPolicyError) return 'ack_not_required';
  if (err instanceof EventBusAckStateError) return 'ack_invalid_state';
  if (!(err instanceof Error)) return null;
  if (err.message.includes('EventBusCursorError')) return 'invalid_cursor';
  if (err.message.includes('EventBusAckPolicyError')) return 'ack_not_required';
  if (err.message.includes('EventBusAckStateError')) return 'ack_invalid_state';
  if (err.message === 'invalid_cursor') return 'invalid_cursor';
  if (err.message === 'ack_not_required') return 'ack_not_required';
  if (err.message === 'ack_invalid_state') return 'ack_invalid_state';
  return null;
}

function toolJson(requestId: string | number | null, body: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  });
}
