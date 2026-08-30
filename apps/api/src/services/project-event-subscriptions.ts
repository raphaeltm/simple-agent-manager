import type {
  ProjectEventDeliveryPreference,
  ProjectEventSubscriptionCaller,
  ProjectEventSubscriptionCancelRequest,
  ProjectEventSubscriptionCancelResponse,
  ProjectEventSubscriptionCreateRequest,
  ProjectEventSubscriptionCreateResponse,
  ProjectEventSubscriptionExpireRequest,
  ProjectEventSubscriptionExpireResponse,
  ProjectEventSubscriptionGetRequest,
  ProjectEventSubscriptionGetResponse,
  ProjectEventSubscriptionListRequest,
  ProjectEventSubscriptionListResponse,
  ProjectEventSubscriptionOwner,
  ProjectEventSubscriptionOwnerScope,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import * as projectDataService from './project-data';
import {
  assertNoCallerProjectId,
  ensureSpecificOwnerMatches,
  normalizeRequestedDelivery,
  normalizeSubscriptionId,
  requireAgentAccess,
  requireAgentCreateIdentity,
  requireCancelAny,
  requireExpire,
  requirePlatformOwnerPermission,
  requirePlatformTargetAccess,
  requireReadAll,
  resolveAgentExpiresAt,
  resolveDeliveryPreference,
  resolveOwnerScope,
  resolvePlatformOwner,
  resolveSurfaceContext,
} from './project-event-subscriptions-access';

export async function createProjectEventSubscriptionForCaller(
  env: Env,
  caller: ProjectEventSubscriptionCaller,
  request: ProjectEventSubscriptionCreateRequest
): Promise<ProjectEventSubscriptionCreateResponse> {
  assertNoCallerProjectId(request as Record<string, unknown>);
  const context = await resolveSurfaceContext(env, caller);
  const requestedDelivery = normalizeRequestedDelivery(request.requestedDelivery);

  let owner: ProjectEventSubscriptionOwner;
  let target: NonNullable<ProjectEventDeliveryPreference['target']>;
  let expiresAt: number | null;

  if (context.callerKind === 'agent') {
    if (caller.kind !== 'agent') throw errors.internal('Invalid event subscription caller state');
    owner = context.owner;
    target = requireAgentCreateIdentity(request, context);
    expiresAt = resolveAgentExpiresAt(env, caller, request.expiresAt);
  } else {
    owner = resolvePlatformOwner(context.platform, request.owner, 'create');
    target = await requirePlatformTargetAccess(env, context.projectId, request.target);
    expiresAt = request.expiresAt ?? null;
  }

  const result = await projectDataService.createProjectEventSubscription(env, context.projectId, {
    owner,
    idempotencyKey: request.idempotencyKey,
    filter: request.filter,
    deliveryPreference: resolveDeliveryPreference(requestedDelivery, target),
    reason: request.reason ?? null,
    expiresAt,
  });
  return { ...result, callerKind: context.callerKind };
}

export async function listProjectEventSubscriptionsForCaller(
  env: Env,
  caller: ProjectEventSubscriptionCaller,
  request: ProjectEventSubscriptionListRequest = {}
): Promise<ProjectEventSubscriptionListResponse> {
  assertNoCallerProjectId(request as Record<string, unknown>);
  const context = await resolveSurfaceContext(env, caller);

  let owner: ProjectEventSubscriptionOwner | null = null;
  let ownerScope: ProjectEventSubscriptionOwnerScope;
  if (context.callerKind === 'agent') {
    if (request.owner || (request.ownerScope && request.ownerScope !== 'caller')) {
      throw errors.forbidden('Agent callers can only list their own event subscriptions');
    }
    owner = context.owner;
    ownerScope = 'caller';
  } else {
    ownerScope = resolveOwnerScope(request, 'all');
    if (ownerScope === 'caller') {
      owner = context.owner;
      requirePlatformOwnerPermission(context.platform, owner, 'read');
    } else if (ownerScope === 'specific') {
      owner = resolvePlatformOwner(context.platform, request.owner, 'read');
    } else {
      requireReadAll(context.platform);
      owner = null;
    }
  }

  const result = await projectDataService.listProjectEventSubscriptions(env, context.projectId, {
    state: request.state ?? 'active',
    owner,
    limit: request.limit ?? null,
  });

  if (context.callerKind === 'agent') {
    return {
      subscriptions: result.subscriptions.filter(
        (subscription) =>
          subscription.deliveryPreference.target?.sessionId === context.target.sessionId
      ),
      hasMore: result.hasMore,
      ownerScope,
    };
  }

  return { ...result, ownerScope };
}

export async function getProjectEventSubscriptionForCaller(
  env: Env,
  caller: ProjectEventSubscriptionCaller,
  request: ProjectEventSubscriptionGetRequest
): Promise<ProjectEventSubscriptionGetResponse> {
  assertNoCallerProjectId(request as Record<string, unknown>);
  const context = await resolveSurfaceContext(env, caller);
  const subscriptionId = normalizeSubscriptionId(request.subscriptionId);
  const required = request.required !== false;

  const subscription = await projectDataService.getProjectEventSubscription(env, context.projectId, {
    subscriptionId,
  });
  if (!subscription) {
    if (!required) return { subscription: null, required };
    throw errors.notFound('Event subscription');
  }

  if (context.callerKind === 'agent') {
    requireAgentAccess(subscription, context);
  } else {
    const ownerScope = resolveOwnerScope(request, 'all');
    if (ownerScope === 'caller') {
      requirePlatformOwnerPermission(context.platform, context.owner, 'read');
      ensureSpecificOwnerMatches(subscription.owner, context.owner);
    } else if (ownerScope === 'specific') {
      const owner = resolvePlatformOwner(context.platform, request.owner, 'read');
      ensureSpecificOwnerMatches(subscription.owner, owner);
    } else {
      requireReadAll(context.platform);
    }
  }

  return { subscription, required };
}

export async function cancelProjectEventSubscriptionForCaller(
  env: Env,
  caller: ProjectEventSubscriptionCaller,
  request: ProjectEventSubscriptionCancelRequest
): Promise<ProjectEventSubscriptionCancelResponse> {
  assertNoCallerProjectId(request as Record<string, unknown>);
  const context = await resolveSurfaceContext(env, caller);
  const subscriptionId = normalizeSubscriptionId(request.subscriptionId);
  const required = request.required !== false;

  const existing = await projectDataService.getProjectEventSubscription(env, context.projectId, {
    subscriptionId,
  });
  if (!existing) {
    if (!required) return { subscription: null, idempotent: true, changed: false, required };
    throw errors.notFound('Event subscription');
  }

  let cancelledBy: ProjectEventSubscriptionOwner;
  if (context.callerKind === 'agent') {
    requireAgentAccess(existing, context);
    cancelledBy = context.owner;
  } else {
    const ownerScope = resolveOwnerScope(request, 'all');
    if (ownerScope === 'caller') {
      requirePlatformOwnerPermission(context.platform, context.owner, 'cancel');
      ensureSpecificOwnerMatches(existing.owner, context.owner);
    } else if (ownerScope === 'specific') {
      const owner = resolvePlatformOwner(context.platform, request.owner, 'cancel');
      ensureSpecificOwnerMatches(existing.owner, owner);
    } else {
      requireCancelAny(context.platform);
      requirePlatformOwnerPermission(context.platform, existing.owner, 'cancel');
    }
    cancelledBy = context.owner;
  }

  const result = await projectDataService.cancelProjectEventSubscription(env, context.projectId, {
    subscriptionId,
    cancelledBy,
    reason: request.reason ?? null,
  });
  return { ...result, required };
}

export async function expireProjectEventSubscriptionsForCaller(
  env: Env,
  caller: ProjectEventSubscriptionCaller,
  request: ProjectEventSubscriptionExpireRequest = {}
): Promise<ProjectEventSubscriptionExpireResponse> {
  assertNoCallerProjectId(request as Record<string, unknown>);
  const context = await resolveSurfaceContext(env, caller);
  if (context.callerKind !== 'platform') {
    throw errors.forbidden('Only platform callers can expire event subscriptions');
  }
  requireExpire(context.platform);
  const result = await projectDataService.expireProjectEventSubscriptions(env, context.projectId, {
    now: request.now,
    limit: request.limit ?? null,
  });
  return { ...result, callerKind: context.callerKind };
}

export function describeProjectEventSubscriptionOwner(owner: ProjectEventSubscriptionOwner): string {
  return `${owner.type}:${owner.id}`;
}
