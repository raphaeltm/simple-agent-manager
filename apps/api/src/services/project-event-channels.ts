import type {
  ProjectEventSubscriptionAgentCaller,
  ProjectEventRequestedDeliveryMode,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectData from './project-data';
import { normalizeRequestedDelivery, resolveAgentExpiresAt, resolveDeliveryPreference, resolveSurfaceContext } from './project-event-subscriptions-access';

export async function channelCallerContext(env: Env, caller: ProjectEventSubscriptionAgentCaller, capability: 'task:read' | 'task:write' = 'task:read') {
  const context = await resolveSurfaceContext(env, caller);
  if (context.callerKind !== 'agent' || !context.target.sessionId) {
    throw errors.forbidden('An active task-backed session is required');
  }
  await requireProjectCapability(drizzle(env.DATABASE, { schema }), context.projectId, caller.userId, capability);
  return context;
}

export async function publishChannelForCaller(env: Env, caller: ProjectEventSubscriptionAgentCaller,
  request: { channel: string; message: string; idempotencyKey: string }) {
  const context = await channelCallerContext(env, caller, 'task:write');
  return projectData.publishProjectEventChannel(env, context.projectId, {
    channel: request.channel, message: request.message, idempotencyKey: request.idempotencyKey,
    actor: { userId: caller.userId, taskId: context.sourceTaskId,
      chatSessionId: context.target.sessionId!, workspaceId: caller.workspaceId },
  });
}

export async function followChannelForCaller(env: Env, caller: ProjectEventSubscriptionAgentCaller,
  request: { channel: string; cursor?: string; idempotencyKey: string;
    requestedDelivery?: ProjectEventRequestedDeliveryMode; reason?: string; expiresAt?: number }) {
  const context = await channelCallerContext(env, caller, 'task:write');
  return projectData.followProjectEventChannel(env, context.projectId, {
    channel: request.channel, cursor: request.cursor, idempotencyKey: request.idempotencyKey,
    owner: context.owner, ownerTaskId: context.sourceTaskId,
    deliveryPreference: resolveDeliveryPreference(normalizeRequestedDelivery(request.requestedDelivery), context.target),
    expiresAt: resolveAgentExpiresAt(env, caller, request.expiresAt), reason: request.reason,
  });
}

export async function catchUpChannelForCaller(env: Env, caller: ProjectEventSubscriptionAgentCaller,
  request: { subscriptionId: string; limit?: number }) {
  const context = await channelCallerContext(env, caller, 'task:write');
  return projectData.catchUpProjectEventChannel(env, context.projectId, {
    subscriptionId: request.subscriptionId, limit: request.limit,
    visibility: { owner: context.owner, legacyOwners: context.legacyOwners, target: context.target },
  });
}
