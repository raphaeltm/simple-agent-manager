import type {
  ProjectEventDeliveryAdapterCapability,
  ProjectEventDeliveryAdapterDecision,
  ProjectEventDeliveryAuthorization,
  ProjectEventDeliveryBatchState,
  ProjectEventDeliveryCapabilityMode,
  ProjectEventDeliveryModelSummary,
  ProjectEventDeliveryPreference,
  ProjectEventDeliveryResolution,
  ProjectEventDeliveryResolutionReason,
  ProjectEventDeliveryTargetState,
  ProjectEventRecord,
  ProjectEventRequestedDeliveryMode,
  ProjectEventResolvedDeliveryMode,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';

export type ResolveProjectEventDeliveryInput = {
  subscription: ProjectEventSubscriptionRecord;
  requestedDelivery?: ProjectEventRequestedDeliveryMode | null;
  resolvedDelivery?: ProjectEventResolvedDeliveryMode | null;
  target?: NonNullable<ProjectEventDeliveryPreference['target']> | null;
  adapterCapabilities?: readonly ProjectEventDeliveryAdapterCapability[] | null;
  authorization?: Partial<ProjectEventDeliveryAuthorization> | null;
  targetState?: ProjectEventDeliveryTargetState | null;
  targetTerminalReason?: string | null;
  events?: readonly ProjectEventRecord[] | null;
  now: number;
  maxSummaryEvents: number;
};

const DEFAULT_AUTHORIZATION: ProjectEventDeliveryAuthorization = {
  allowPromptQueue: false,
  allowRuntimeSteer: false,
  allowRuntimeInterrupt: false,
  allowTaskSpawn: false,
};

const EMPTY_TARGET: NonNullable<ProjectEventDeliveryPreference['target']> = {
  sessionId: null,
  taskId: null,
  runtimeId: null,
  agentId: null,
};

type EffectiveDeliveryResolutionInput = Omit<
  ResolveProjectEventDeliveryInput,
  'adapterCapabilities' | 'authorization' | 'events' | 'target' | 'requestedDelivery'
> & {
  requestedDelivery: ProjectEventRequestedDeliveryMode;
  target: NonNullable<ProjectEventDeliveryPreference['target']>;
  adapterCapabilities: readonly ProjectEventDeliveryAdapterCapability[];
  authorization: ProjectEventDeliveryAuthorization;
  modelVisibleSummary: ProjectEventDeliveryModelSummary;
};

type DeliveryCapabilityRequirement = {
  capability: ProjectEventDeliveryCapabilityMode;
  authorizationField: keyof ProjectEventDeliveryAuthorization;
  action: ProjectEventDeliveryAdapterDecision['action'];
  resolvedDelivery: ProjectEventResolvedDeliveryMode;
};

export function resolveProjectEventDelivery(
  input: ResolveProjectEventDeliveryInput
): ProjectEventDeliveryResolution {
  const requestedDelivery =
    input.requestedDelivery ?? input.subscription.deliveryPreference.requested;
  const target = mergeDeliveryTarget(input.subscription.deliveryPreference.target, input.target);
  const adapterCapabilities = [...(input.adapterCapabilities ?? [])].sort((a, b) =>
    a.adapterId.localeCompare(b.adapterId)
  );
  const authorization = {
    ...DEFAULT_AUTHORIZATION,
    ...(input.authorization ?? {}),
  };
  const modelVisibleSummary = buildProjectEventDeliveryModelSummary(
    input.events ?? [],
    input.maxSummaryEvents
  );
  const effectiveInput: EffectiveDeliveryResolutionInput = {
    ...input,
    requestedDelivery,
    target,
    adapterCapabilities,
    authorization,
    modelVisibleSummary,
  };

  if (requestedDelivery !== input.subscription.deliveryPreference.requested) {
    return terminalResolution(
      effectiveInput,
      'recorded_not_injected',
      'ambiguous_delivery',
      `requested delivery ${requestedDelivery} does not match subscription request ${input.subscription.deliveryPreference.requested}`
    );
  }

  const inactiveReason = inactiveSubscriptionReason(input.subscription, input.now);
  if (inactiveReason) {
    return {
      ...terminalResolution(
        effectiveInput,
        'recorded_not_injected',
        'subscription_inactive',
        inactiveReason.reason
      ),
      batchState: inactiveReason.batchState,
    };
  }

  const baseResolution = resolveActiveSubscriptionDelivery(effectiveInput);
  if (input.resolvedDelivery && input.resolvedDelivery !== baseResolution.resolvedDelivery) {
    return terminalResolution(
      effectiveInput,
      'recorded_not_injected',
      'ambiguous_delivery',
      `provided resolved delivery ${input.resolvedDelivery} conflicts with resolver result ${baseResolution.resolvedDelivery}`
    );
  }

  return baseResolution;
}

export function buildProjectEventDeliveryModelSummary(
  events: readonly ProjectEventRecord[],
  maxEvents: number
): ProjectEventDeliveryModelSummary {
  const limit = Math.max(0, Math.floor(maxEvents));
  const visibleEvents = events.slice(0, limit).map((event) => ({
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    subject: event.subject,
    severity: event.severity,
    display: event.display,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
  }));
  return {
    version: 1,
    eventCount: events.length,
    events: visibleEvents,
    truncated: events.length > visibleEvents.length,
  };
}

function resolveActiveSubscriptionDelivery(
  input: EffectiveDeliveryResolutionInput
): ProjectEventDeliveryResolution {
  if (input.requestedDelivery === 'record_only') {
    return terminalResolution(
      input,
      'record_only',
      'record_only_requested',
      'subscription requested record-only delivery'
    );
  }

  if (input.targetState === 'terminal') {
    return terminalResolution(
      input,
      'recorded_not_injected',
      'target_terminal',
      input.targetTerminalReason ?? 'delivery target is terminal'
    );
  }

  const requirement = requirementFor(input.requestedDelivery);
  const selectedAdapter = selectAdapter(input.adapterCapabilities, requirement.capability);
  if (selectedAdapter && !input.authorization[requirement.authorizationField]) {
    return terminalResolution(
      input,
      'unauthorized',
      'unauthorized_delivery',
      `delivery ${input.requestedDelivery} is not authorized`,
      selectedAdapter,
      requirement.capability
    );
  }
  if (selectedAdapter) {
    return pendingResolution(
      input,
      requirement.resolvedDelivery,
      'adapter_supported',
      requirement.action,
      selectedAdapter,
      requirement.capability
    );
  }

  const queueFallback = queueFallbackFor(input);
  if (queueFallback) return queueFallback;

  return terminalResolution(
    input,
    'unsupported',
    'unsupported_delivery',
    `delivery ${input.requestedDelivery} is not supported by an advertised adapter`,
    null,
    requirement.capability
  );
}

function queueFallbackFor(
  input: EffectiveDeliveryResolutionInput
): ProjectEventDeliveryResolution | null {
  if (
    input.requestedDelivery !== 'runtime_steer' &&
    input.requestedDelivery !== 'runtime_interrupt'
  ) {
    return null;
  }
  if (!input.target.sessionId) return null;
  const queueAdapter = selectAdapter(input.adapterCapabilities, 'durable_prompt_queue');
  if (!queueAdapter) return null;
  if (!input.authorization.allowPromptQueue) {
    return terminalResolution(
      input,
      'unauthorized',
      'unauthorized_delivery',
      'durable prompt queue fallback is not authorized',
      queueAdapter,
      'durable_prompt_queue'
    );
  }
  return pendingResolution(
    input,
    'queued_for_prompt_delivery',
    'queue_fallback',
    'queue_prompt_delivery',
    queueAdapter,
    'durable_prompt_queue'
  );
}

function requirementFor(
  requested: ProjectEventRequestedDeliveryMode
): DeliveryCapabilityRequirement {
  switch (requested) {
    case 'existing_session_prompt':
      return {
        capability: 'durable_prompt_queue',
        authorizationField: 'allowPromptQueue',
        action: 'queue_prompt_delivery',
        resolvedDelivery: 'queued_for_prompt_delivery',
      };
    case 'runtime_steer':
      return {
        capability: 'runtime_steer',
        authorizationField: 'allowRuntimeSteer',
        action: 'runtime_steer',
        resolvedDelivery: 'runtime_steer',
      };
    case 'runtime_interrupt':
      return {
        capability: 'runtime_interrupt',
        authorizationField: 'allowRuntimeInterrupt',
        action: 'runtime_interrupt',
        resolvedDelivery: 'runtime_interrupt',
      };
    case 'spawn_task':
      return {
        capability: 'spawn_task',
        authorizationField: 'allowTaskSpawn',
        action: 'spawn_task',
        resolvedDelivery: 'spawn_task',
      };
    case 'record_only':
      return {
        capability: 'record_only',
        authorizationField: 'allowPromptQueue',
        action: 'record_only',
        resolvedDelivery: 'record_only',
      };
  }
}

function pendingResolution(
  input: EffectiveDeliveryResolutionInput,
  resolvedDelivery: ProjectEventResolvedDeliveryMode,
  reason: ProjectEventDeliveryResolutionReason,
  action: ProjectEventDeliveryAdapterDecision['action'],
  adapter: ProjectEventDeliveryAdapterCapability,
  capability: ProjectEventDeliveryCapabilityMode
): ProjectEventDeliveryResolution {
  return {
    requestedDelivery: input.requestedDelivery,
    resolvedDelivery,
    batchState: 'pending',
    target: input.target,
    adapterDecision: adapterDecision(action, reason, adapter, capability, {
      supported: true,
      authorized: true,
      terminal: false,
    }),
    terminalReason: null,
    modelVisibleSummary: input.modelVisibleSummary,
  };
}

function terminalResolution(
  input: EffectiveDeliveryResolutionInput,
  resolvedDelivery: ProjectEventResolvedDeliveryMode,
  reason: ProjectEventDeliveryResolutionReason,
  terminalReason: string,
  adapter: ProjectEventDeliveryAdapterCapability | null = null,
  capability: ProjectEventDeliveryCapabilityMode | null = null
): ProjectEventDeliveryResolution {
  return {
    requestedDelivery: input.requestedDelivery,
    resolvedDelivery,
    batchState: 'recorded_not_injected',
    target: input.target,
    adapterDecision: adapterDecision(
      actionForTerminalResolution(resolvedDelivery),
      reason,
      adapter,
      capability,
      {
        supported: resolvedDelivery !== 'unsupported',
        authorized: resolvedDelivery !== 'unauthorized',
        terminal: true,
      }
    ),
    terminalReason,
    modelVisibleSummary: input.modelVisibleSummary,
  };
}

function actionForTerminalResolution(
  resolvedDelivery: ProjectEventResolvedDeliveryMode
): ProjectEventDeliveryAdapterDecision['action'] {
  switch (resolvedDelivery) {
    case 'record_only':
      return 'record_only';
    case 'unsupported':
      return 'unsupported';
    case 'unauthorized':
      return 'unauthorized';
    case 'recorded_not_injected':
    case 'queued_for_prompt_delivery':
    case 'runtime_steer':
    case 'runtime_interrupt':
    case 'spawn_task':
      return 'recorded_not_injected';
  }
}

function adapterDecision(
  action: ProjectEventDeliveryAdapterDecision['action'],
  reason: ProjectEventDeliveryResolutionReason,
  adapter: ProjectEventDeliveryAdapterCapability | null,
  capability: ProjectEventDeliveryCapabilityMode | null,
  outcome: Pick<ProjectEventDeliveryAdapterDecision, 'supported' | 'authorized' | 'terminal'>
): ProjectEventDeliveryAdapterDecision {
  return {
    action,
    reason,
    adapterId: adapter?.adapterId ?? null,
    adapterKind: adapter?.adapterKind ?? null,
    capability,
    agentType: adapter?.agentType ?? null,
    protocol: adapter?.protocol ?? null,
    protocolVersion: adapter?.protocolVersion ?? null,
    durableAck: adapter?.durableAck ?? false,
    supported: outcome.supported,
    authorized: outcome.authorized,
    terminal: outcome.terminal,
  };
}

function selectAdapter(
  adapters: readonly ProjectEventDeliveryAdapterCapability[],
  capability: ProjectEventDeliveryCapabilityMode
): ProjectEventDeliveryAdapterCapability | null {
  return (
    adapters.find(
      (adapter) =>
        adapter.available &&
        adapter.versionGate?.satisfied !== false &&
        adapter.capabilities.includes(capability) &&
        (capability !== 'durable_prompt_queue' || adapter.durableAck)
    ) ?? null
  );
}

function inactiveSubscriptionReason(
  subscription: ProjectEventSubscriptionRecord,
  now: number
): {
  reason: string;
  batchState: Extract<ProjectEventDeliveryBatchState, 'cancelled' | 'expired'>;
} | null {
  if (subscription.state === 'cancelled') {
    return { reason: 'subscription cancelled before delivery', batchState: 'cancelled' };
  }
  if (
    subscription.state === 'expired' ||
    (subscription.expiresAt !== null && subscription.expiresAt <= now)
  ) {
    return { reason: 'subscription expired before delivery', batchState: 'expired' };
  }
  return null;
}

function mergeDeliveryTarget(
  subscriptionTarget: ProjectEventDeliveryPreference['target'],
  batchTarget: ProjectEventDeliveryPreference['target'] | null | undefined
): NonNullable<ProjectEventDeliveryPreference['target']> {
  return {
    sessionId: batchTarget?.sessionId ?? subscriptionTarget?.sessionId ?? EMPTY_TARGET.sessionId,
    taskId: batchTarget?.taskId ?? subscriptionTarget?.taskId ?? EMPTY_TARGET.taskId,
    runtimeId: batchTarget?.runtimeId ?? subscriptionTarget?.runtimeId ?? EMPTY_TARGET.runtimeId,
    agentId: batchTarget?.agentId ?? subscriptionTarget?.agentId ?? EMPTY_TARGET.agentId,
  };
}
