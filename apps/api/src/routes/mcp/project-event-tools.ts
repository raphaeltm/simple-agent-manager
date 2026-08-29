import type {
  ProjectEventDeliveryAckResult,
  ProjectEventSubscriptionEventListResult,
  ProjectEventSubscriptionEventSummary,
} from '@simple-agent-manager/shared';

import {
  decodeProjectEventSubscriptionEventsCursor,
  isProjectEventSubscriptionEventsCursorToken,
} from '../../durable-objects/project-data/project-events-cursors';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { AppError } from '../../middleware/error';
import {
  ProjectEventAckPolicyError,
  ProjectEventAckStateError,
  ProjectEventCursorError,
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from '../../services/project-data';
import {
  ackProjectEventDeliveryForCaller,
  getProjectEventForCaller,
  listProjectEventSubscriptionEventsForCaller,
  ProjectEventCallerIdentityError,
} from '../../services/project-event-deliveries';
import {
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

type JsonRpcRequestId = string | number | null;

export interface ProjectEventToolStorageAdapter {
  getProjectEventForCaller: typeof getProjectEventForCaller;
  listProjectEventSubscriptionEventsForCaller: typeof listProjectEventSubscriptionEventsForCaller;
  ackProjectEventDeliveryForCaller: typeof ackProjectEventDeliveryForCaller;
}

const defaultStorage: ProjectEventToolStorageAdapter = {
  getProjectEventForCaller,
  listProjectEventSubscriptionEventsForCaller,
  ackProjectEventDeliveryForCaller,
};

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
  requestId: JsonRpcRequestId,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage: ProjectEventToolStorageAdapter = defaultStorage
): Promise<JsonRpcResponse> {
  const identityValidation = rejectUnexpectedParams(requestId, params, GET_EVENT_FIELDS);
  if (identityValidation) return identityValidation;
  const eventId = normalizeStringParam(requestId, params.eventId, 'eventId');
  if ('jsonrpc' in eventId) return eventId;

  try {
    const event = await storage.getProjectEventForCaller(env, agentCallerFromToken(tokenData), {
      eventId: eventId.value,
    });
    if (!event) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Event not found or not visible to this agent'
      );
    }
    return toolJson(requestId, { event });
  } catch (err) {
    return mapProjectEventToolError(requestId, 'get_event', err);
  }
}

export async function handleListSubscriptionEvents(
  requestId: JsonRpcRequestId,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage: ProjectEventToolStorageAdapter = defaultStorage
): Promise<JsonRpcResponse> {
  const identityValidation = rejectUnexpectedParams(
    requestId,
    params,
    LIST_SUBSCRIPTION_EVENTS_FIELDS
  );
  if (identityValidation) return identityValidation;
  const subscriptionId = normalizeStringParam(requestId, params.subscriptionId, 'subscriptionId');
  if ('jsonrpc' in subscriptionId) return subscriptionId;
  const cursor = resolveCursorParam(requestId, params.cursor, subscriptionId.value, env);
  if ('jsonrpc' in cursor) return cursor;
  const limit = resolveProjectEventListLimit(requestId, params.limit, env);
  if ('jsonrpc' in limit) return limit;

  try {
    const result = await storage.listProjectEventSubscriptionEventsForCaller(
      env,
      agentCallerFromToken(tokenData),
      {
        subscriptionId: subscriptionId.value,
        limit: limit.value,
        cursor: cursor.value,
        cursorMaxLength: getMcpLimits(env).projectEventCursorMaxLength,
      }
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
    return mapProjectEventToolError(requestId, 'list_subscription_events', err);
  }
}

export async function handleAckEventDelivery(
  requestId: JsonRpcRequestId,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage: ProjectEventToolStorageAdapter = defaultStorage
): Promise<JsonRpcResponse> {
  const identityValidation = rejectUnexpectedParams(requestId, params, ACK_EVENT_DELIVERY_FIELDS);
  if (identityValidation) return identityValidation;
  const deliveryId = normalizeStringParam(requestId, params.deliveryId, 'deliveryId');
  if ('jsonrpc' in deliveryId) return deliveryId;

  try {
    const result = await storage.ackProjectEventDeliveryForCaller(
      env,
      agentCallerFromToken(tokenData),
      { deliveryId: deliveryId.value }
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
    return mapProjectEventToolError(requestId, 'ack_event_delivery', err);
  }
}

function agentCallerFromToken(tokenData: McpTokenData) {
  if (!tokenData.taskId) {
    throw new ProjectEventCallerIdentityError();
  }
  return {
    kind: 'agent' as const,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    workspaceId: tokenData.workspaceId,
    taskId: tokenData.taskId,
    chatSessionId: tokenData.chatSessionId ?? null,
    agentSessionId: tokenData.agentSessionId ?? null,
    ownerName: tokenData.agentSessionId ?? tokenData.taskId,
    mcpTokenCreatedAt: tokenData.createdAt,
  };
}

function rejectUnexpectedParams(
  requestId: JsonRpcRequestId,
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

function normalizeStringParam(
  requestId: JsonRpcRequestId,
  raw: unknown,
  field: string
): { value: string } | JsonRpcResponse {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return jsonRpcError(requestId, INVALID_PARAMS, `${field} is required`);
  return { value };
}

function resolveCursorParam(
  requestId: JsonRpcRequestId,
  raw: unknown,
  subscriptionId: string,
  env: Env
): { value: string | null } | JsonRpcResponse {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'cursor must be a string when provided');
  }
  const cursor = raw.trim();
  if (!cursor) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'cursor must be non-empty when provided');
  }
  const cursorMaxLength = getMcpLimits(env).projectEventCursorMaxLength;
  if (!isProjectEventSubscriptionEventsCursorToken(cursor, cursorMaxLength)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid cursor');
  }
  try {
    decodeProjectEventSubscriptionEventsCursor(cursor, subscriptionId, cursorMaxLength);
  } catch {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid cursor');
  }
  return { value: cursor };
}

function resolveProjectEventListLimit(
  requestId: JsonRpcRequestId,
  raw: unknown,
  env: Env
): { value: number } | JsonRpcResponse {
  const limits = getMcpLimits(env);
  if (raw === undefined) {
    return { value: Math.min(limits.projectEventListLimit, limits.projectEventListMax) };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'limit must be a finite number when provided');
  }
  if (!Number.isInteger(raw)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'limit must be an integer when provided');
  }
  if (raw <= 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'limit must be greater than 0');
  }
  return { value: Math.min(raw, limits.projectEventListMax) };
}

function sanitizeListResult(
  result: ProjectEventSubscriptionEventListResult
): ProjectEventSubscriptionEventListResult {
  return {
    subscriptionId: result.subscriptionId,
    events: result.events.map(sanitizeEventSummary),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  };
}

function sanitizeEventSummary(
  event: ProjectEventSubscriptionEventSummary
): ProjectEventSubscriptionEventSummary {
  return {
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    subject: event.subject,
    severity: event.severity,
    metadata: event.metadata,
    display: event.display,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    matchId: event.matchId,
    payloadRefAvailable: event.payloadRefAvailable,
    delivery: event.delivery,
  };
}

function sanitizeAckResult(result: ProjectEventDeliveryAckResult): ProjectEventDeliveryAckResult {
  return {
    acknowledged: true,
    idempotent: result.idempotent,
    delivery: result.delivery,
  };
}

function mapProjectEventToolError(
  requestId: JsonRpcRequestId,
  toolName: string,
  err: unknown
): JsonRpcResponse {
  if (err instanceof ProjectEventCallerIdentityError) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Caller identity is not valid for this project');
  }
  if (err instanceof ProjectEventCursorError || errorNameIncludes(err, 'ProjectEventCursorError')) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid cursor');
  }
  if (
    err instanceof ProjectEventAckPolicyError ||
    errorNameIncludes(err, 'ProjectEventAckPolicyError')
  ) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Delivery does not require acknowledgement');
  }
  if (
    err instanceof ProjectEventAckStateError ||
    errorNameIncludes(err, 'ProjectEventAckStateError')
  ) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Delivery cannot be acknowledged in its current state'
    );
  }
  if (err instanceof AppError && [400, 403, 404].includes(err.statusCode)) {
    return jsonRpcError(requestId, INVALID_PARAMS, err.message);
  }
  if (
    err instanceof ProjectEventValidationError ||
    err instanceof ProjectEventLimitExceededError ||
    errorNameIncludes(err, 'ProjectEventValidationError') ||
    errorNameIncludes(err, 'ProjectEventLimitExceededError')
  ) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      err instanceof Error ? err.message : String(err)
    );
  }
  log.error(`mcp.${toolName}.failed`, {
    error: err instanceof Error ? err.message : String(err),
  });
  return jsonRpcError(requestId, INTERNAL_ERROR, `Tool '${toolName}' failed`);
}

function errorNameIncludes(err: unknown, name: string): boolean {
  return err instanceof Error && (err.name === name || err.message.includes(name));
}

function toolJson(requestId: JsonRpcRequestId, body: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  });
}
