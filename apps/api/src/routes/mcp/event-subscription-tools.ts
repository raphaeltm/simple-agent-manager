import type {
  ProjectEventFilterV1,
  ProjectEventSubscriptionCreateRequest,
  ProjectEventSubscriptionState,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { AppError } from '../../middleware/error';
import {
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
} from '../../services/project-data';
import {
  cancelProjectEventSubscriptionForCaller,
  createProjectEventSubscriptionForCaller,
  getProjectEventSubscriptionForCaller,
  listProjectEventSubscriptionsForCaller,
} from '../../services/project-event-subscriptions';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

function textResult(requestId: string | number | null, payload: Record<string, unknown>) {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
}

function agentCallerFromToken(tokenData: McpTokenData) {
  if (!tokenData.taskId) {
    throw new AppError(400, 'BAD_REQUEST', 'Only task agents can manage event subscriptions');
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

function rejectIdentityOverrides(params: Record<string, unknown>): void {
  for (const field of ['projectId', 'owner', 'ownerScope', 'cancelledBy']) {
    if (Object.prototype.hasOwnProperty.call(params, field)) {
      throw new AppError(403, 'FORBIDDEN', `${field} is derived from MCP caller context`);
    }
  }
}

function normalizeRequired(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AppError(400, 'BAD_REQUEST', 'required must be a boolean');
  }
  return value;
}

function normalizeLimit(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(400, 'BAD_REQUEST', 'limit must be a positive integer');
  }
  return value;
}

function normalizeExpiresAt(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AppError(400, 'BAD_REQUEST', 'expiresAt must be a millisecond timestamp integer');
  }
  return value;
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'BAD_REQUEST', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return normalizeString(value, field);
}

function normalizeFilter(value: unknown): ProjectEventFilterV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(400, 'BAD_REQUEST', 'filter must be an object');
  }
  return value as ProjectEventFilterV1;
}

function normalizeTarget(value: unknown): ProjectEventSubscriptionCreateRequest['target'] {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'BAD_REQUEST', 'target must be an object');
  }
  return value as ProjectEventSubscriptionCreateRequest['target'];
}

function normalizeState(value: unknown): ProjectEventSubscriptionState | 'any' | null | undefined {
  if (value === undefined || value === null) return value;
  if (value === 'active' || value === 'cancelled' || value === 'expired' || value === 'any') {
    return value;
  }
  throw new AppError(400, 'BAD_REQUEST', 'state must be active, cancelled, expired, or any');
}

function mapEventSubscriptionError(
  requestId: string | number | null,
  toolName: string,
  err: unknown
): JsonRpcResponse {
  if (err instanceof AppError) {
    return jsonRpcError(requestId, INVALID_PARAMS, err.message, {
      httpStatus: err.statusCode,
      error: err.error,
    });
  }
  if (
    err instanceof ProjectEventValidationError ||
    err instanceof ProjectEventLimitExceededError ||
    err instanceof ProjectEventIdempotencyConflictError ||
    err instanceof ProjectEventNotFoundError
  ) {
    return jsonRpcError(requestId, INVALID_PARAMS, err.message, {
      error: 'PROJECT_EVENT_SUBSCRIPTION_ERROR',
      code: err.code,
    });
  }
  log.error('mcp.event_subscription_tool_failed', {
    tool: toolName,
    error: err instanceof Error ? err.message : String(err),
  });
  return jsonRpcError(requestId, INTERNAL_ERROR, `Tool '${toolName}' failed`);
}

export async function handleCreateProjectEventSubscription(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    rejectIdentityOverrides(params);
    const result = await createProjectEventSubscriptionForCaller(env, agentCallerFromToken(tokenData), {
      idempotencyKey: normalizeString(params.idempotencyKey, 'idempotencyKey'),
      filter: normalizeFilter(params.filter),
      requestedDelivery: normalizeString(params.requestedDelivery, 'requestedDelivery') as ProjectEventSubscriptionCreateRequest['requestedDelivery'],
      target: normalizeTarget(params.target),
      reason: normalizeOptionalString(params.reason, 'reason') ?? null,
      expiresAt: normalizeExpiresAt(params.expiresAt),
    });
    return textResult(requestId, {
      subscription: result.subscription,
      idempotent: result.idempotent,
      changed: result.changed,
      callerKind: result.callerKind,
    });
  } catch (err) {
    return mapEventSubscriptionError(requestId, 'create_project_event_subscription', err);
  }
}

export async function handleListProjectEventSubscriptions(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    rejectIdentityOverrides(params);
    const result = await listProjectEventSubscriptionsForCaller(env, agentCallerFromToken(tokenData), {
      state: normalizeState(params.state),
      limit: normalizeLimit(params.limit),
    });
    return textResult(requestId, result);
  } catch (err) {
    return mapEventSubscriptionError(requestId, 'list_project_event_subscriptions', err);
  }
}

export async function handleGetProjectEventSubscription(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    rejectIdentityOverrides(params);
    const result = await getProjectEventSubscriptionForCaller(env, agentCallerFromToken(tokenData), {
      subscriptionId: normalizeString(params.subscriptionId, 'subscriptionId'),
      required: normalizeRequired(params.required),
    });
    return textResult(requestId, result);
  } catch (err) {
    return mapEventSubscriptionError(requestId, 'get_project_event_subscription', err);
  }
}

export async function handleCancelProjectEventSubscription(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    rejectIdentityOverrides(params);
    const result = await cancelProjectEventSubscriptionForCaller(
      env,
      agentCallerFromToken(tokenData),
      {
        subscriptionId: normalizeString(params.subscriptionId, 'subscriptionId'),
        reason: normalizeOptionalString(params.reason, 'reason') ?? null,
        required: normalizeRequired(params.required),
      }
    );
    return textResult(requestId, result);
  } catch (err) {
    return mapEventSubscriptionError(requestId, 'cancel_project_event_subscription', err);
  }
}
