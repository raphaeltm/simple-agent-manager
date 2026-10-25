/**
 * Input normalization for event subscriptions and delivery batches: owner, delivery preference,
 * target and idempotency fingerprint. Event admission and filter normalization stay in
 * project-events-normalization.ts.
 */
import {
  type CreateProjectEventDeliveryBatchInput,
  type CreateProjectEventSubscriptionInput,
  PROJECT_EVENT_REQUESTED_DELIVERY_MODES,
  PROJECT_EVENT_RESOLVED_DELIVERY_MODES,
  PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES,
  type ProjectEventDeliveryAdapterCapability,
  type ProjectEventDeliveryAuthorization,
  type ProjectEventDeliveryPreference,
  type ProjectEventDeliveryTargetState,
  type ProjectEventLimits,
  type ProjectEventSubscriptionOwner,
} from '@simple-agent-manager/shared';

import { ProjectEventValidationError } from './project-events-contracts';
import {
  normalizeAdapterCapabilities,
  normalizeDeliveryAuthorization,
  normalizeDeliveryTargetState,
} from './project-events-delivery-input-normalization';
import {
  type CompiledProjectEventFilter,
  compileProjectEventFilter,
  normalizeProjectId,
} from './project-events-normalization';
import {
  isPlainObject,
  normalizeNullableText,
  normalizeStringSet,
  normalizeText,
  normalizeTimestamp,
  stableStringify,
} from './project-events-values';

export type NormalizedSubscriptionInput = {
  projectId: string;
  owner: ProjectEventSubscriptionOwner;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  compiledFilter: CompiledProjectEventFilter;
  deliveryPreference: ProjectEventDeliveryPreference;
  ownerTaskId: string | null;
  reason: string | null;
  expiresAt: number | null;
  /** Requested wake spacing raised to the platform wake cooldown; null keeps the cooldown alone. */
  minWakeIntervalMs: number | null;
};

export type NormalizedDeliveryBatchInput = {
  projectId: string;
  subscriptionId: string;
  matchIds: string[];
  idempotencyKey: string;
  idempotencyFingerprint: string;
  requestedDelivery: ProjectEventDeliveryPreference['requested'] | null;
  resolvedDelivery: ProjectEventDeliveryPreference['resolved'] | null;
  target: NonNullable<ProjectEventDeliveryPreference['target']>;
  adapterCapabilities: ProjectEventDeliveryAdapterCapability[];
  authorization: ProjectEventDeliveryAuthorization;
  targetState: ProjectEventDeliveryTargetState | null;
  targetTerminalReason: string | null;
  terminalReason: string | null;
};

const OWNER_TYPE_SET = new Set<string>(PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES);
const REQUESTED_DELIVERY_SET = new Set<string>(PROJECT_EVENT_REQUESTED_DELIVERY_MODES);
const RESOLVED_DELIVERY_SET = new Set<string>(PROJECT_EVENT_RESOLVED_DELIVERY_MODES);

export function normalizeSubscriptionInput(
  input: CreateProjectEventSubscriptionInput,
  limits: ProjectEventLimits
): NormalizedSubscriptionInput {
  const projectId = normalizeProjectId(input.projectId, limits);
  const owner = normalizeOwner(input.owner, limits);
  const idempotencyKey = normalizeText(
    input.idempotencyKey,
    'idempotencyKey',
    limits.maxFilterStringBytes
  );
  const compiledFilter = compileProjectEventFilter(input.filter, limits);
  const deliveryPreference = normalizeDeliveryPreference(input.deliveryPreference, limits);
  const ownerTaskId = normalizeNullableText(
    input.ownerTaskId ?? null,
    'ownerTaskId',
    limits.maxFilterStringBytes
  );
  const reason = normalizeNullableText(input.reason ?? null, 'reason', limits.maxReasonBytes);
  const expiresAt =
    input.expiresAt === null || input.expiresAt === undefined
      ? null
      : normalizeTimestamp(input.expiresAt, 'expiresAt');
  const requestedMinWakeIntervalMs = normalizeMinWakeIntervalMs(
    input.minWakeIntervalMs,
    deliveryPreference,
    limits
  );
  const idempotencyFingerprint = stableStringify([
    projectId,
    owner.type,
    owner.id,
    compiledFilter.fingerprint,
    deliveryPreference,
    ownerTaskId,
    reason,
    expiresAt,
    // Appended only when set, so a retry of a subscription created before the field existed
    // keeps its stored fingerprint.
    ...(requestedMinWakeIntervalMs === null
      ? []
      : [{ minWakeIntervalMs: requestedMinWakeIntervalMs }]),
  ]);

  return {
    projectId,
    owner,
    idempotencyKey,
    idempotencyFingerprint,
    compiledFilter,
    deliveryPreference,
    ownerTaskId,
    reason,
    expiresAt,
    minWakeIntervalMs:
      requestedMinWakeIntervalMs === null
        ? null
        : Math.max(requestedMinWakeIntervalMs, limits.wakeSubscriptionCooldownMs),
  };
}

/**
 * Agent-chosen spacing between wakes. Only a subscription that wakes its chat can use it, and it
 * cannot exceed the wake delivery lifetime: past that no further wake could be delivered.
 */
function normalizeMinWakeIntervalMs(
  value: number | null | undefined,
  deliveryPreference: ProjectEventDeliveryPreference,
  limits: ProjectEventLimits
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectEventValidationError(
      'minimum wake interval must be a positive whole number of milliseconds'
    );
  }
  if (deliveryPreference.resolved !== 'queued_for_prompt_delivery') {
    throw new ProjectEventValidationError(
      'minimum wake interval applies only to subscriptions that wake the chat ' +
        '(requestedDelivery existing_session_prompt or runtime_interrupt)'
    );
  }
  if (value > limits.wakeSubscriptionLifetimeMs) {
    throw new ProjectEventValidationError(
      'minimum wake interval cannot exceed the wake subscription lifetime of ' +
        `${Math.floor(limits.wakeSubscriptionLifetimeMs / 1000)} seconds`
    );
  }
  return value;
}

export function normalizeDeliveryBatchInput(
  input: CreateProjectEventDeliveryBatchInput,
  limits: ProjectEventLimits
): NormalizedDeliveryBatchInput {
  const projectId = normalizeProjectId(input.projectId, limits);
  const subscriptionId = normalizeText(
    input.subscriptionId,
    'subscriptionId',
    limits.maxFilterStringBytes
  );
  const matchIds = normalizeStringSet(
    input.matchIds,
    'matchIds',
    limits.maxDeliveryBatchEvents,
    limits.maxFilterStringBytes
  );
  const idempotencyKey = normalizeText(
    input.idempotencyKey,
    'idempotencyKey',
    limits.maxFilterStringBytes
  );
  const requestedDelivery = normalizeOptionalRequestedDelivery(input.requestedDelivery);
  const resolvedDelivery = normalizeOptionalResolvedDelivery(input.resolvedDelivery);
  const target = normalizeDeliveryTarget(input.target, limits);
  const adapterCapabilities = normalizeAdapterCapabilities(input.adapterCapabilities, limits);
  const authorization = normalizeDeliveryAuthorization(input.authorization);
  const targetState = normalizeDeliveryTargetState(input.targetState);
  const targetTerminalReason = normalizeNullableText(
    input.targetTerminalReason ?? null,
    'targetTerminalReason',
    limits.maxReasonBytes
  );
  const terminalReason = normalizeNullableText(
    input.terminalReason ?? null,
    'terminalReason',
    limits.maxReasonBytes
  );
  const idempotencyFingerprint = stableStringify([
    projectId,
    subscriptionId,
    matchIds,
    requestedDelivery,
    resolvedDelivery,
    target,
    adapterCapabilities,
    authorization,
    targetState,
    targetTerminalReason,
    terminalReason,
  ]);

  return {
    projectId,
    subscriptionId,
    matchIds,
    idempotencyKey,
    idempotencyFingerprint,
    requestedDelivery,
    resolvedDelivery,
    target,
    adapterCapabilities,
    authorization,
    targetState,
    targetTerminalReason,
    terminalReason,
  };
}

function normalizeOwner(
  input: ProjectEventSubscriptionOwner,
  limits: ProjectEventLimits
): ProjectEventSubscriptionOwner {
  if (!isPlainObject(input)) throw new ProjectEventValidationError('owner must be an object');
  if (typeof input.type !== 'string' || !OWNER_TYPE_SET.has(input.type)) {
    throw new ProjectEventValidationError('owner type is not allowed');
  }
  return {
    type: input.type,
    id: normalizeText(input.id, 'owner.id', limits.maxFilterStringBytes),
    name: normalizeNullableText(input.name ?? null, 'owner.name', limits.maxFilterStringBytes),
  };
}

function normalizeDeliveryPreference(
  input: ProjectEventDeliveryPreference,
  limits: ProjectEventLimits
): ProjectEventDeliveryPreference {
  if (!isPlainObject(input)) {
    throw new ProjectEventValidationError('deliveryPreference must be an object');
  }
  if (!REQUESTED_DELIVERY_SET.has(input.requested)) {
    throw new ProjectEventValidationError('requested delivery mode is not allowed');
  }
  if (!RESOLVED_DELIVERY_SET.has(input.resolved)) {
    throw new ProjectEventValidationError('resolved delivery mode is not allowed');
  }
  return {
    requested: input.requested,
    resolved: input.resolved,
    target: normalizeDeliveryTarget(input.target, limits),
  };
}

function normalizeOptionalRequestedDelivery(
  input: ProjectEventDeliveryPreference['requested'] | null | undefined
): ProjectEventDeliveryPreference['requested'] | null {
  if (input === null || input === undefined) return null;
  if (!REQUESTED_DELIVERY_SET.has(input)) {
    throw new ProjectEventValidationError('requestedDelivery is not allowed');
  }
  return input;
}

function normalizeOptionalResolvedDelivery(
  input: ProjectEventDeliveryPreference['resolved'] | null | undefined
): ProjectEventDeliveryPreference['resolved'] | null {
  if (input === null || input === undefined) return null;
  if (!RESOLVED_DELIVERY_SET.has(input)) {
    throw new ProjectEventValidationError('resolvedDelivery is not allowed');
  }
  return input;
}

function normalizeDeliveryTarget(
  input: ProjectEventDeliveryPreference['target'],
  limits: ProjectEventLimits
): NonNullable<ProjectEventDeliveryPreference['target']> {
  return {
    sessionId: normalizeNullableText(
      input?.sessionId ?? null,
      'target.sessionId',
      limits.maxFilterStringBytes
    ),
    taskId: normalizeNullableText(
      input?.taskId ?? null,
      'target.taskId',
      limits.maxFilterStringBytes
    ),
    runtimeId: normalizeNullableText(
      input?.runtimeId ?? null,
      'target.runtimeId',
      limits.maxFilterStringBytes
    ),
    agentId: normalizeNullableText(
      input?.agentId ?? null,
      'target.agentId',
      limits.maxFilterStringBytes
    ),
  };
}
