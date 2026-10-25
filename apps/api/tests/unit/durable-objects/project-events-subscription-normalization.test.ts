import {
  type CreateProjectEventSubscriptionInput,
  DEFAULT_PROJECT_EVENT_LIMITS,
  type ProjectEventDeliveryPreference,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { normalizeSubscriptionInput } from '../../../src/durable-objects/project-data/project-events-subscription-normalization';
import { stableStringify } from '../../../src/durable-objects/project-data/project-events-values';

const limits = DEFAULT_PROJECT_EVENT_LIMITS;
const target = { sessionId: 'chat-1', taskId: 'task-1' };
const wakeDelivery: ProjectEventDeliveryPreference = {
  requested: 'existing_session_prompt',
  resolved: 'queued_for_prompt_delivery',
  target,
};

function input(
  overrides: Partial<CreateProjectEventSubscriptionInput> = {}
): CreateProjectEventSubscriptionInput {
  return {
    projectId: 'project-1',
    owner: { type: 'agent', id: 'agent-1', name: 'Agent' },
    idempotencyKey: 'follow-builds',
    filter: { version: 1, source: 'sam.agent_channel', subjectId: 'builds' },
    deliveryPreference: wakeDelivery,
    ownerTaskId: 'task-1',
    reason: null,
    expiresAt: 1_900_000_000_000,
    ...overrides,
  };
}

describe('subscription minimum wake interval normalization', () => {
  it('keeps the fingerprint format of subscriptions created before the field existed', () => {
    const normalized = normalizeSubscriptionInput(input(), limits);
    expect(normalized.minWakeIntervalMs).toBeNull();
    // Stored fingerprints of existing subscriptions were computed from exactly this tuple, so a
    // retried create without an interval must still replay instead of conflicting.
    expect(normalized.idempotencyFingerprint).toBe(
      stableStringify([
        normalized.projectId,
        normalized.owner.type,
        normalized.owner.id,
        normalized.compiledFilter.fingerprint,
        normalized.deliveryPreference,
        normalized.ownerTaskId,
        normalized.reason,
        normalized.expiresAt,
      ])
    );
    expect(
      normalizeSubscriptionInput(input({ minWakeIntervalMs: null }), limits).idempotencyFingerprint
    ).toBe(normalized.idempotencyFingerprint);
  });

  it('fingerprints the requested interval and stores it raised to the platform cooldown', () => {
    const below = normalizeSubscriptionInput(input({ minWakeIntervalMs: 5_000 }), limits);
    const above = normalizeSubscriptionInput(input({ minWakeIntervalMs: 600_000 }), limits);
    const unset = normalizeSubscriptionInput(input(), limits);
    expect(below.minWakeIntervalMs).toBe(limits.wakeSubscriptionCooldownMs);
    expect(above.minWakeIntervalMs).toBe(600_000);
    expect(
      new Set([
        below.idempotencyFingerprint,
        above.idempotencyFingerprint,
        unset.idempotencyFingerprint,
      ]).size
    ).toBe(3);
  });

  it('applies the interval to runtime_interrupt wakes too', () => {
    const normalized = normalizeSubscriptionInput(
      input({
        minWakeIntervalMs: 600_000,
        deliveryPreference: { ...wakeDelivery, requested: 'runtime_interrupt' },
      }),
      limits
    );
    expect(normalized.minWakeIntervalMs).toBe(600_000);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '600'])(
    'rejects a malformed interval: %s',
    (value) => {
      expect(() =>
        normalizeSubscriptionInput(input({ minWakeIntervalMs: value as number }), limits)
      ).toThrow('minimum wake interval must be a positive whole number of milliseconds');
    }
  );

  it.each([
    { requested: 'record_only', resolved: 'record_only' },
    { requested: 'runtime_steer', resolved: 'recorded_not_injected' },
  ] as const)('rejects an interval when delivery resolves to $resolved', (delivery) => {
    expect(() =>
      normalizeSubscriptionInput(
        input({ minWakeIntervalMs: 600_000, deliveryPreference: { ...delivery, target } }),
        limits
      )
    ).toThrow('applies only to subscriptions that wake the chat');
    // Control: the same subscription without an interval is valid.
    expect(
      normalizeSubscriptionInput(input({ deliveryPreference: { ...delivery, target } }), limits)
        .minWakeIntervalMs
    ).toBeNull();
  });

  it('bounds the interval by the configured wake cooldown and lifetime', () => {
    expect(
      normalizeSubscriptionInput(
        input({ minWakeIntervalMs: limits.wakeSubscriptionLifetimeMs }),
        limits
      ).minWakeIntervalMs
    ).toBe(limits.wakeSubscriptionLifetimeMs);
    expect(() =>
      normalizeSubscriptionInput(
        input({ minWakeIntervalMs: limits.wakeSubscriptionLifetimeMs + 1 }),
        limits
      )
    ).toThrow('cannot exceed the wake subscription lifetime of 86400 seconds');

    const configured = {
      ...limits,
      wakeSubscriptionCooldownMs: 120_000,
      wakeSubscriptionLifetimeMs: 3_600_000,
    };
    expect(
      normalizeSubscriptionInput(input({ minWakeIntervalMs: 60_000 }), configured).minWakeIntervalMs
    ).toBe(120_000);
    expect(() =>
      normalizeSubscriptionInput(input({ minWakeIntervalMs: 3_600_001 }), configured)
    ).toThrow('of 3600 seconds');
  });
});
