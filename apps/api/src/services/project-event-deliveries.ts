import type {
  ProjectEventDeliveryAckResult,
  ProjectEventSubscriptionAgentCaller,
  ProjectEventSubscriptionEvent,
  ProjectEventSubscriptionEventListResult,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { AppError } from '../middleware/error';
import * as projectDataService from './project-data';
import {
  type AgentSubscriptionContext,
  normalizeSubscriptionId,
  resolveSurfaceContext,
} from './project-event-subscriptions-access';

export class ProjectEventCallerIdentityError extends Error {
  constructor() {
    super('Caller identity is not valid for this project');
    this.name = 'ProjectEventCallerIdentityError';
  }
}

export type ProjectEventGetRequest = {
  eventId: string;
};

export type ProjectEventSubscriptionEventsListRequest = {
  subscriptionId: string;
  limit?: number | null;
  cursor?: string | null;
  cursorMaxLength?: number | null;
};

export type ProjectEventDeliveryAckRequest = {
  deliveryId: string;
};

export async function getProjectEventForCaller(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  request: ProjectEventGetRequest
): Promise<ProjectEventSubscriptionEvent | null> {
  const context = await resolveAgentDeliveryContext(env, caller);
  return projectDataService.getProjectEvent(env, context.projectId, {
    eventId: normalizeNonEmptyString(request.eventId),
    visibility: { owner: context.owner, target: context.target },
  });
}

export async function listProjectEventSubscriptionEventsForCaller(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  request: ProjectEventSubscriptionEventsListRequest
): Promise<ProjectEventSubscriptionEventListResult | null> {
  const context = await resolveAgentDeliveryContext(env, caller);
  return projectDataService.listProjectEventSubscriptionEvents(env, context.projectId, {
    subscriptionId: normalizeSubscriptionId(request.subscriptionId),
    limit: request.limit ?? null,
    cursor: request.cursor ?? null,
    cursorMaxLength: request.cursorMaxLength ?? null,
    visibility: { owner: context.owner, target: context.target },
  });
}

export async function ackProjectEventDeliveryForCaller(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  request: ProjectEventDeliveryAckRequest
): Promise<ProjectEventDeliveryAckResult | null> {
  const context = await resolveAgentDeliveryContext(env, caller);
  return projectDataService.ackProjectEventDelivery(env, context.projectId, {
    deliveryId: normalizeNonEmptyString(request.deliveryId),
    visibility: { owner: context.owner, target: context.target },
    acknowledgedBy: context.owner,
  });
}

async function resolveAgentDeliveryContext(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller
): Promise<AgentSubscriptionContext> {
  try {
    const context = await resolveSurfaceContext(env, caller);
    if (context.callerKind !== 'agent') throw new ProjectEventCallerIdentityError();
    return context;
  } catch (error) {
    if (error instanceof ProjectEventCallerIdentityError) throw error;
    if (error instanceof AppError) throw new ProjectEventCallerIdentityError();
    throw error;
  }
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectEventCallerIdentityError();
  }
  return value.trim();
}
