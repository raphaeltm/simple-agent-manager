import { describe, expect, it } from 'vitest';

import {
  appendProvisioningAttempt,
  createPlacementExplanation,
  evaluatePlacementNode,
  resolvePlacementRequest,
} from '../../../src/services/placement-explanation';

const nowMs = Date.parse('2026-08-11T12:00:00.000Z');
const requiredVersion = 'a'.repeat(40);
const request = resolvePlacementRequest(
  {
    VM_AGENT_REQUIRED_VERSION: requiredVersion,
    MAX_WORKSPACES_PER_NODE: '5',
    TASK_RUN_NODE_CPU_THRESHOLD_PERCENT: '50',
    TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT: '60',
    NODE_HEARTBEAT_STALE_SECONDS: '180',
  },
  'medium',
  'hel1'
);

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: 'node-1',
    status: 'running',
    runtime: 'vm',
    vmSize: 'medium',
    vmLocation: 'hel1',
    healthStatus: 'healthy',
    lastHeartbeatAt: '2026-08-11T11:59:30.000Z',
    agentReadyAt: '2026-08-11T11:59:00.000Z',
    agentVersion: requiredVersion,
    lastMetrics: JSON.stringify({ cpuLoadAvg1: 8, memoryPercent: 20 }),
    activeWorkspaceCount: 2,
    warmSince: '2026-08-11T11:00:00.000Z',
    ...overrides,
  } as Parameters<typeof evaluatePlacementNode>[0];
}

describe('typed placement evaluation', () => {
  it('accepts the production-like healthy medium/hel1 node at 2/5 and low load', () => {
    const evaluation = evaluatePlacementNode(
      node({ id: '01KZR2JAP92AK3SKW951E4H21M' }),
      request,
      'capacity',
      requiredVersion,
      nowMs
    );

    expect(evaluation.accepted).toBe(true);
    expect(evaluation.rejectionReasons).toEqual([]);
    expect(evaluation.snapshot).toMatchObject({
      activeWorkspaceCount: 2,
      cpuLoadAvg1: 8,
      memoryPercent: 20,
      agentVersionCompatible: true,
    });
  });

  it.each([
    ['not-running', { status: 'stopped' }],
    ['wrong-runtime', { runtime: 'cf-container' }],
    ['unhealthy', { healthStatus: 'unhealthy' }],
    ['heartbeat-missing', { lastHeartbeatAt: null }],
    ['heartbeat-stale', { lastHeartbeatAt: '2026-08-11T11:00:00.000Z' }],
    ['agent-not-ready', { agentReadyAt: null }],
    ['agent-version-mismatch', { agentVersion: 'b'.repeat(40) }],
    ['undersized', { vmSize: 'small' }],
    ['workspace-limit', { activeWorkspaceCount: 5 }],
    ['cpu-threshold', { lastMetrics: JSON.stringify({ cpuLoadAvg1: 50, memoryPercent: 1 }) }],
    ['memory-threshold', { lastMetrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 60 }) }],
    ['not-warm', { warmSince: null }],
  ])('records %s without raw diagnostic data', (reason, overrides) => {
    const evaluation = evaluatePlacementNode(
      node(overrides),
      request,
      reason === 'not-warm' ? 'warm' : 'capacity',
      requiredVersion,
      nowMs
    );

    expect(evaluation.accepted).toBe(false);
    expect(evaluation.rejectionReasons).toContain(reason);
  });

  it('keeps exact compatibility and excludes raw versions, metrics fields, and canaries', () => {
    const canary = 'CANARY_SECRET_DO_NOT_PERSIST';
    const evaluation = evaluatePlacementNode(
      node({
        agentVersion: `wrong-${canary}`,
        lastMetrics: JSON.stringify({
          cpuLoadAvg1: 10,
          memoryPercent: 20,
          rawProcessList: canary,
          providerError: canary,
        }),
      }),
      request,
      'manual',
      requiredVersion,
      nowMs
    );
    const serialized = JSON.stringify(evaluation);

    expect(evaluation.rejectionReasons).toContain('agent-version-mismatch');
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(requiredVersion);
    expect(serialized).not.toContain('rawProcessList');
    expect(serialized).not.toContain('providerError');
  });

  it('records provisioning outcomes using only typed failure reasons', () => {
    const explanation = appendProvisioningAttempt(
      createPlacementExplanation(request, 'provisioning', '2026-08-11T12:00:00.000Z'),
      {
        vmSize: 'medium',
        vmLocation: 'hel1',
        outcome: 'failed',
        failureReason: 'provider-failed',
      },
      'node-new',
      '2026-08-11T12:01:00.000Z'
    );

    expect(explanation).toMatchObject({
      schemaVersion: 2,
      outcome: 'failed',
      selectedNodeId: 'node-new',
      provisioningAttempts: [{ failureReason: 'provider-failed' }],
    });
  });

  it('clears a rejected provisional node before trying a fallback size', () => {
    const started = appendProvisioningAttempt(
      createPlacementExplanation(request, 'provisioning', '2026-08-11T12:00:00.000Z'),
      { vmSize: 'large', vmLocation: 'hel1', outcome: 'started' },
      'node-rejected'
    );
    const rejected = appendProvisioningAttempt(
      started,
      {
        vmSize: 'large',
        vmLocation: 'hel1',
        outcome: 'capacity-rejected',
        failureReason: 'capacity-unavailable',
      },
      null
    );

    expect(rejected.selectedNodeId).toBeNull();
    expect(rejected.provisioningAttempts).toHaveLength(2);
  });
});
