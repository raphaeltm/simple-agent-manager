import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  compileProjectEventFilter,
  normalizeDeliveryBatchInput,
  normalizeProjectEventInput,
} from '../../../src/durable-objects/project-data/project-events-normalization';

const baseLimits = DEFAULT_PROJECT_EVENT_LIMITS;

describe('ProjectData event subscription normalization', () => {
  it('compiles v1 filters to deterministic bounded match keys', () => {
    const first = compileProjectEventFilter(
      {
        version: 1,
        source: ['github', 'github'],
        eventType: ['pull_request.closed', 'pull_request.opened'],
        severity: ['warning', 'info'],
      },
      baseLimits
    );
    const second = compileProjectEventFilter(
      {
        version: 1,
        severity: ['info', 'warning'],
        eventType: ['pull_request.opened', 'pull_request.closed'],
        source: 'github',
      },
      baseLimits
    );

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.matchKeys.map((key) => key.matchKey)).toEqual([
      'eventType=pull_request.closed',
      'eventType=pull_request.opened',
      'severity=info',
      'severity=warning',
      'source=github',
    ]);
  });

  it('rejects empty, unknown, predicate-shaped, invalid-severity, and overlimit filters', () => {
    expect(() => compileProjectEventFilter({ version: 1 }, baseLimits)).toThrow(/at least one/);
    expect(() =>
      compileProjectEventFilter({ version: 1, predicate: 'source == github' } as never, baseLimits)
    ).toThrow(/not allowed/);
    expect(() =>
      compileProjectEventFilter({ version: 1, source: { regex: 'github' } } as never, baseLimits)
    ).toThrow(/must be a string/);
    expect(() =>
      compileProjectEventFilter({ version: 1, severity: 'fatal' } as never, baseLimits)
    ).toThrow(/severity/);
    expect(() =>
      compileProjectEventFilter(
        { version: 1, source: ['a', 'b'] },
        { ...baseLimits, maxFilterValuesPerField: 1 }
      )
    ).toThrow(/1 values/);
  });

  it('normalizes bounded metadata, display data, and raw-payload references without raw bodies', () => {
    const normalized = normalizeProjectEventInput(
      {
        projectId: 'project-events-unit',
        source: 'github',
        eventType: 'check_suite.completed',
        subject: { type: 'pull_request', id: '42' },
        severity: 'warning',
        deliveryKey: 'github-delivery-1',
        payloadFingerprint: 'sha256:fingerprint-1',
        metadata: {
          conclusion: 'failure',
          command: 'SECURITY_CANARY_DO_NOT_EXECUTE',
        },
        display: {
          title: 'CI failed',
          summary: 'SECURITY_CANARY_DO_NOT_EXECUTE remains quoted data',
          labels: ['ci', 'failure'],
        },
        rawPayloadRef: {
          provider: 'github',
          uri: 'r2://private/github-delivery-1',
          contentHash: 'sha256:payload',
        },
        occurredAt: 1000,
        receivedAt: 1001,
      },
      baseLimits
    );

    expect(normalized.display.untrusted).toBe(true);
    expect(normalized.metadataJson).toContain('SECURITY_CANARY_DO_NOT_EXECUTE');
    expect(normalized.displayJson).toContain('SECURITY_CANARY_DO_NOT_EXECUTE');
    expect(normalized.rawPayloadRefJson).toContain('r2://private/github-delivery-1');
    expect(normalized).not.toHaveProperty('rawPayloadBody');
  });

  it('rejects deep or oversized normalized metadata', () => {
    expect(() =>
      normalizeProjectEventInput(
        {
          projectId: 'project-events-unit',
          source: 'github',
          eventType: 'check_suite.completed',
          subject: { type: 'pull_request', id: '42' },
          deliveryKey: 'github-delivery-1',
          payloadFingerprint: 'sha256:fingerprint-1',
          metadata: { a: { b: { c: 'too-deep' } } },
        },
        { ...baseLimits, maxMetadataDepth: 1 }
      )
    ).toThrow(/depth/);

    expect(() =>
      normalizeProjectEventInput(
        {
          projectId: 'project-events-unit',
          source: 'github',
          eventType: 'check_suite.completed',
          subject: { type: 'pull_request', id: '42' },
          deliveryKey: 'github-delivery-1',
          payloadFingerprint: 'sha256:fingerprint-1',
          metadata: { oversized: 'x'.repeat(baseLimits.maxMetadataBytes) },
        },
        baseLimits
      )
    ).toThrow(/metadata/);
  });

  it('normalizes adapter capability records that advertise no delivery modes', () => {
    const normalized = normalizeDeliveryBatchInput(
      {
        projectId: 'project-events-unit',
        subscriptionId: 'subscription-1',
        matchIds: ['match-1'],
        idempotencyKey: 'batch-1',
        adapterCapabilities: [
          {
            adapterId: 'opencode-acp',
            adapterKind: 'runtime_acp',
            agentType: 'opencode',
            protocol: 'opencode-acp',
            protocolVersion: '1.17.18',
            capabilities: [],
            durableAck: false,
            available: true,
          },
        ],
        authorization: { allowRuntimeSteer: true },
        targetState: 'active',
      },
      baseLimits
    );

    expect(normalized.adapterCapabilities).toEqual([
      {
        adapterId: 'opencode-acp',
        adapterKind: 'runtime_acp',
        agentType: 'opencode',
        protocol: 'opencode-acp',
        protocolVersion: '1.17.18',
        capabilities: [],
        durableAck: false,
        available: true,
        versionGate: null,
      },
    ]);
    expect(normalized.authorization.allowRuntimeSteer).toBe(true);
  });
});
