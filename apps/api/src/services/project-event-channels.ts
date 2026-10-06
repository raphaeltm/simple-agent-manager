import type {
  ProjectEventRequestedDeliveryMode,
  ProjectEventSubscriptionAgentCaller,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectData from './project-data';
import { getProjectEventWakeInstructions } from './project-event-subscriptions';
import {
  normalizeRequestedDelivery,
  resolveAgentExpiresAt,
  resolveDeliveryPreference,
  resolveSurfaceContext,
} from './project-event-subscriptions-access';

export async function channelCallerContext(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  capability: 'task:read' | 'task:write' = 'task:read'
) {
  const context = await resolveSurfaceContext(env, caller);
  if (context.callerKind !== 'agent' || !context.target.sessionId) {
    throw errors.forbidden('An active task-backed session is required');
  }
  const sessionId = context.target.sessionId;
  const session = await projectData.getSession(env, context.projectId, sessionId);
  if (!session || session.status !== 'active' || session.taskId !== context.target.taskId) {
    throw errors.forbidden('The calling chat is not active for this task');
  }
  await requireProjectCapability(
    drizzle(env.DATABASE, { schema }),
    context.projectId,
    caller.userId,
    capability
  );
  return { ...context, target: { ...context.target, sessionId } };
}

export async function publishChannelForCaller(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  request: { channel: string; message: string; idempotencyKey: string }
) {
  const context = await channelCallerContext(env, caller, 'task:write');
  return projectData.publishProjectEventChannel(env, context.projectId, {
    channel: request.channel,
    message: request.message,
    idempotencyKey: request.idempotencyKey,
    actor: {
      userId: caller.userId,
      taskId: caller.taskId,
      chatSessionId: context.target.sessionId,
      workspaceId: caller.workspaceId,
      agentSessionId: caller.agentSessionId ?? null,
    },
  });
}

export async function followChannelForCaller(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  request: {
    channel: string;
    cursor?: string;
    idempotencyKey: string;
    requestedDelivery?: ProjectEventRequestedDeliveryMode;
    reason?: string;
    expiresAt?: number;
  }
) {
  const context = await channelCallerContext(env, caller, 'task:write');
  const result = await projectData.followProjectEventChannel(env, context.projectId, {
    channel: request.channel,
    cursor: request.cursor,
    idempotencyKey: request.idempotencyKey,
    owner: context.owner,
    ownerTaskId: context.sourceTaskId,
    actor: {
      userId: caller.userId,
      taskId: caller.taskId,
      workspaceId: caller.workspaceId,
      chatSessionId: context.target.sessionId,
      agentSessionId: caller.agentSessionId ?? null,
    },
    deliveryPreference: resolveDeliveryPreference(
      normalizeRequestedDelivery(request.requestedDelivery ?? 'record_only'),
      context.target
    ),
    expiresAt: request.expiresAt,
    defaultExpiresAt: resolveAgentExpiresAt(env, caller, request.expiresAt),
    reason: request.reason,
  });
  return {
    ...result,
    wakeInstructions: getProjectEventWakeInstructions(result.subscription.deliveryPreference),
  };
}

export async function catchUpChannelForCaller(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  request: { subscriptionId: string; limit?: number }
) {
  const context = await channelCallerContext(env, caller, 'task:write');
  const result = await projectData.catchUpProjectEventChannel(env, context.projectId, {
    subscriptionId: request.subscriptionId,
    limit: request.limit,
    visibility: {
      owner: context.owner,
      legacyOwners: context.legacyOwners,
      target: context.target,
    },
    actor: {
      userId: caller.userId,
      taskId: caller.taskId,
      workspaceId: caller.workspaceId,
      chatSessionId: context.target.sessionId,
      agentSessionId: caller.agentSessionId ?? null,
    },
  });
  return {
    ...result,
    wakeInstructions: getProjectEventWakeInstructions(result.subscription.deliveryPreference),
  };
}
