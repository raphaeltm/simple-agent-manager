import type {
  ProjectEventDeliveryAdapterCapability,
  ProjectEventRecord,
  ProjectEventRequestedDeliveryMode,
  ProjectEventResolvedDeliveryMode,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { resolveProjectEventDelivery } from '../../../src/durable-objects/project-data/project-events';

const NOW = 10_000;

function subscription(
  requested: ProjectEventRequestedDeliveryMode,
  overrides: Partial<ProjectEventSubscriptionRecord> = {}
): ProjectEventSubscriptionRecord {
  const resolved: ProjectEventResolvedDeliveryMode =
    requested === 'record_only' ? 'record_only' : 'recorded_not_injected';
  return {
    id: 'subscription-1',
    projectId: 'project-1',
    contractVersion: 1,
    owner: { type: 'agent', id: 'agent-1', name: 'Agent One' },
    idempotencyKey: 'subscription-key',
    filter: { version: 1, source: 'github' },
    filterFingerprint: '{"source":"github","version":1}',
    matchKeyCount: 1,
    deliveryPreference: {
      requested,
      resolved,
      target: {
        sessionId: 'session-1',
        taskId: 'task-1',
        runtimeId: 'runtime-1',
        agentId: 'agent-1',
      },
    },
    state: 'active',
    reason: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    lastMatchedAt: null,
    ...overrides,
  };
}

function adapter(
  capabilities: ProjectEventDeliveryAdapterCapability['capabilities'],
  overrides: Partial<ProjectEventDeliveryAdapterCapability> = {}
): ProjectEventDeliveryAdapterCapability {
  return {
    adapterId: 'adapter-1',
    adapterKind: 'runtime_acp',
    agentType: 'openai-codex',
    protocol: 'codex-acp',
    protocolVersion: '1.7.0',
    capabilities,
    durableAck: false,
    available: true,
    versionGate: null,
    ...overrides,
  };
}

function queueAdapter(): ProjectEventDeliveryAdapterCapability {
  return adapter(['durable_prompt_queue'], {
    adapterId: 'projectdata-prompt-queue',
    adapterKind: 'durable_queue',
    agentType: null,
    protocol: 'projectdata',
    protocolVersion: '1',
    durableAck: true,
  });
}

function event(overrides: Partial<ProjectEventRecord> = {}): ProjectEventRecord {
  return {
    id: 'event-1',
    projectId: 'project-1',
    contractVersion: 1,
    source: 'github',
    eventType: 'check_suite.completed',
    subject: { type: 'pull_request', id: '42' },
    severity: 'warning',
    deliveryKey: 'delivery-1',
    payloadFingerprint: 'sha256:fingerprint',
    metadata: {
      secret: 'RAW_METADATA_SHOULD_NOT_BE_MODEL_VISIBLE',
    },
    display: {
      title: 'CI failed',
      summary: 'bounded display summary',
      labels: ['ci'],
      untrusted: true,
    },
    rawPayloadRef: {
      provider: 'github',
      uri: 'r2://private/raw-payload',
      contentHash: 'sha256:raw',
    },
    occurredAt: 9_000,
    receivedAt: 9_001,
    updatedAt: 9_001,
    state: 'recorded',
    duplicateCount: 0,
    conflictCount: 0,
    conflictFingerprint: null,
    conflictDetectedAt: null,
    ...overrides,
  };
}

describe('ProjectData event delivery resolver', () => {
  it('selects a supported runtime steer adapter only when capability and version gate are explicit', () => {
    const result = resolveProjectEventDelivery({
      subscription: subscription('runtime_steer'),
      adapterCapabilities: [
        adapter(['runtime_steer'], {
          adapterId: 'codex-app-server-steering',
          versionGate: {
            dependencyName: '@agentclientprotocol/codex-acp',
            currentVersion: '1.7.0',
            minimumVersion: '1.7.0',
            satisfied: true,
          },
        }),
      ],
      authorization: { allowRuntimeSteer: true },
      now: NOW,
      maxSummaryEvents: 10,
    });

    expect(result).toMatchObject({
      requestedDelivery: 'runtime_steer',
      resolvedDelivery: 'runtime_steer',
      batchState: 'pending',
      adapterDecision: {
        action: 'runtime_steer',
        reason: 'adapter_supported',
        adapterId: 'codex-app-server-steering',
        supported: true,
        authorized: true,
        terminal: false,
      },
    });
  });

  it('does not infer Codex or OpenCode steering from agentType alone', () => {
    const codexWithoutAdvertisedSteering = resolveProjectEventDelivery({
      subscription: subscription('runtime_steer'),
      adapterCapabilities: [
        adapter(['runtime_steer'], {
          adapterId: 'codex-acp-1-1-2',
          protocolVersion: '1.1.2',
          versionGate: {
            dependencyName: '@agentclientprotocol/codex-acp',
            currentVersion: '1.1.2',
            minimumVersion: '1.7.0',
            satisfied: false,
          },
        }),
      ],
      authorization: { allowRuntimeSteer: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(codexWithoutAdvertisedSteering).toMatchObject({
      resolvedDelivery: 'unsupported',
      adapterDecision: {
        action: 'unsupported',
        adapterId: null,
        reason: 'unsupported_delivery',
        supported: false,
      },
    });

    const opencodeAcpWithoutSteerQueue = resolveProjectEventDelivery({
      subscription: subscription('runtime_steer'),
      adapterCapabilities: [
        adapter([], {
          adapterId: 'opencode-acp',
          adapterKind: 'runtime_acp',
          agentType: 'opencode',
          protocol: 'opencode-acp',
          protocolVersion: '1.17.18',
        }),
      ],
      authorization: { allowRuntimeSteer: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(opencodeAcpWithoutSteerQueue.resolvedDelivery).toBe('unsupported');
  });

  it('distinguishes unsupported capabilities from unauthorized supported capabilities', () => {
    const unsupported = resolveProjectEventDelivery({
      subscription: subscription('runtime_interrupt'),
      adapterCapabilities: [],
      authorization: { allowRuntimeInterrupt: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(unsupported).toMatchObject({
      resolvedDelivery: 'unsupported',
      adapterDecision: { action: 'unsupported', supported: false, authorized: true },
    });

    const unauthorized = resolveProjectEventDelivery({
      subscription: subscription('runtime_interrupt'),
      adapterCapabilities: [adapter(['runtime_interrupt'])],
      authorization: { allowRuntimeInterrupt: false },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(unauthorized).toMatchObject({
      resolvedDelivery: 'unauthorized',
      adapterDecision: {
        action: 'unauthorized',
        adapterId: 'adapter-1',
        supported: true,
        authorized: false,
      },
    });
  });

  it('records terminal targets without selecting queue or runtime delivery', () => {
    const result = resolveProjectEventDelivery({
      subscription: subscription('existing_session_prompt'),
      adapterCapabilities: [queueAdapter()],
      authorization: { allowPromptQueue: true },
      targetState: 'terminal',
      targetTerminalReason: 'session already stopped',
      now: NOW,
      maxSummaryEvents: 10,
    });

    expect(result).toMatchObject({
      resolvedDelivery: 'recorded_not_injected',
      batchState: 'recorded_not_injected',
      terminalReason: 'session already stopped',
      adapterDecision: {
        action: 'recorded_not_injected',
        reason: 'target_terminal',
        terminal: true,
      },
    });
  });

  it('terminalizes cancelled and expired subscriptions before delivery policy is evaluated', () => {
    const cancelled = resolveProjectEventDelivery({
      subscription: subscription('existing_session_prompt', { state: 'cancelled' }),
      adapterCapabilities: [queueAdapter()],
      authorization: { allowPromptQueue: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(cancelled).toMatchObject({
      batchState: 'cancelled',
      resolvedDelivery: 'recorded_not_injected',
      adapterDecision: { reason: 'subscription_inactive' },
    });

    const expired = resolveProjectEventDelivery({
      subscription: subscription('existing_session_prompt', { expiresAt: NOW - 1 }),
      adapterCapabilities: [queueAdapter()],
      authorization: { allowPromptQueue: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(expired).toMatchObject({
      batchState: 'expired',
      resolvedDelivery: 'recorded_not_injected',
      adapterDecision: { reason: 'subscription_inactive' },
    });
  });

  it('marks caller delivery overrides as ambiguous when they conflict with the subscription or resolver', () => {
    const requestedConflict = resolveProjectEventDelivery({
      subscription: subscription('existing_session_prompt'),
      requestedDelivery: 'runtime_steer',
      adapterCapabilities: [queueAdapter()],
      authorization: { allowPromptQueue: true, allowRuntimeSteer: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(requestedConflict).toMatchObject({
      resolvedDelivery: 'recorded_not_injected',
      adapterDecision: { action: 'recorded_not_injected', reason: 'ambiguous_delivery' },
    });

    const resolvedConflict = resolveProjectEventDelivery({
      subscription: subscription('existing_session_prompt'),
      resolvedDelivery: 'recorded_not_injected',
      adapterCapabilities: [queueAdapter()],
      authorization: { allowPromptQueue: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(resolvedConflict).toMatchObject({
      resolvedDelivery: 'recorded_not_injected',
      adapterDecision: { action: 'recorded_not_injected', reason: 'ambiguous_delivery' },
    });
  });

  it('keeps record-only delivery independent of adapter capability', () => {
    const result = resolveProjectEventDelivery({
      subscription: subscription('record_only'),
      adapterCapabilities: [],
      authorization: {},
      now: NOW,
      maxSummaryEvents: 10,
    });

    expect(result).toMatchObject({
      requestedDelivery: 'record_only',
      resolvedDelivery: 'record_only',
      batchState: 'recorded_not_injected',
      adapterDecision: {
        action: 'record_only',
        reason: 'record_only_requested',
        adapterId: null,
        supported: true,
        authorized: true,
      },
    });
  });

  it('falls back from unsupported live steering to the durable prompt queue when authorized', () => {
    const result = resolveProjectEventDelivery({
      subscription: subscription('runtime_steer'),
      adapterCapabilities: [queueAdapter()],
      authorization: { allowPromptQueue: true, allowRuntimeSteer: true },
      now: NOW,
      maxSummaryEvents: 10,
    });

    expect(result).toMatchObject({
      requestedDelivery: 'runtime_steer',
      resolvedDelivery: 'queued_for_prompt_delivery',
      batchState: 'pending',
      adapterDecision: {
        action: 'queue_prompt_delivery',
        reason: 'queue_fallback',
        adapterId: 'projectdata-prompt-queue',
        capability: 'durable_prompt_queue',
      },
    });
  });

  it('requires explicit authorization for spawn and interrupt decisions', () => {
    const spawnBlocked = resolveProjectEventDelivery({
      subscription: subscription('spawn_task'),
      adapterCapabilities: [
        adapter(['spawn_task'], { adapterId: 'sam-task-spawner', adapterKind: 'task_spawn' }),
      ],
      authorization: { allowTaskSpawn: false },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(spawnBlocked).toMatchObject({
      resolvedDelivery: 'unauthorized',
      adapterDecision: { action: 'unauthorized', capability: 'spawn_task' },
    });

    const spawnAllowed = resolveProjectEventDelivery({
      subscription: subscription('spawn_task'),
      adapterCapabilities: [
        adapter(['spawn_task'], { adapterId: 'sam-task-spawner', adapterKind: 'task_spawn' }),
      ],
      authorization: { allowTaskSpawn: true },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(spawnAllowed).toMatchObject({
      resolvedDelivery: 'spawn_task',
      batchState: 'pending',
      adapterDecision: { action: 'spawn_task', adapterId: 'sam-task-spawner' },
    });

    const interruptBlocked = resolveProjectEventDelivery({
      subscription: subscription('runtime_interrupt'),
      adapterCapabilities: [adapter(['runtime_interrupt'])],
      authorization: { allowRuntimeInterrupt: false },
      now: NOW,
      maxSummaryEvents: 10,
    });
    expect(interruptBlocked).toMatchObject({
      resolvedDelivery: 'unauthorized',
      adapterDecision: { action: 'unauthorized', capability: 'runtime_interrupt' },
    });
  });

  it('builds model-visible summaries from bounded display data only', () => {
    const result = resolveProjectEventDelivery({
      subscription: subscription('record_only'),
      events: [event(), event({ id: 'event-2', deliveryKey: 'delivery-2' })],
      now: NOW,
      maxSummaryEvents: 1,
    });

    expect(result.modelVisibleSummary).toMatchObject({
      eventCount: 2,
      truncated: true,
      events: [
        {
          id: 'event-1',
          display: {
            title: 'CI failed',
            summary: 'bounded display summary',
            untrusted: true,
          },
        },
      ],
    });
    const serialized = JSON.stringify(result.modelVisibleSummary);
    expect(serialized).not.toContain('RAW_METADATA_SHOULD_NOT_BE_MODEL_VISIBLE');
    expect(serialized).not.toContain('rawPayloadRef');
    expect(serialized).not.toContain('r2://private/raw-payload');
    expect(serialized).not.toContain('payloadFingerprint');
    expect(serialized).not.toContain('deliveryKey');
  });
});
