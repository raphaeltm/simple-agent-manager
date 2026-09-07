import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  type ActiveWorkspaceReservationUsage,
  emptyUsage,
  evaluateWorkspaceReservationCapacity,
  isResolvedResourceReservation,
  normalizeLoadAverageToCpuPercent,
  parseWorkspaceAdmissionMetrics,
  type WorkspaceAdmissionPolicy,
} from '../../../src/services/workspace-resource-capacity';

function reservation(
  overrides: Partial<ResolvedResourceReservation> = {}
): ResolvedResourceReservation {
  return {
    cpuMillis: 1000,
    memoryMb: 1024,
    diskMb: 1024,
    exclusiveNode: false,
    maxCoTenants: 4,
    source: 'platform',
    sourceId: 'platform',
    version: 1,
    ...overrides,
  };
}

function policy(overrides: Partial<WorkspaceAdmissionPolicy> = {}): WorkspaceAdmissionPolicy {
  return {
    maxWorkspaces: 4,
    cpuShareBudgetPercent: 100,
    hostMemoryReserveMb: 512,
    diskPressureThresholdPercent: 90,
    metricsTtlMs: 180_000,
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    cpuScoreWeightPercent: 40,
    memoryScoreWeightPercent: 60,
    ...overrides,
  };
}

function usage(overrides: Partial<ActiveWorkspaceReservationUsage> = {}) {
  return { ...emptyUsage(), ...overrides };
}

describe('workspace resource capacity accounting', () => {
  it('accepts v1 and v2 reservation snapshots and rejects malformed future snapshots', () => {
    expect(isResolvedResourceReservation(reservation())).toBe(true);
    expect(
      isResolvedResourceReservation({
        ...reservation({ version: 2 }),
        fieldProvenance: { minVcpu: { source: 'task', sourceId: 'task-1' } },
        diagnostics: { resolver: 'canonical-a' },
      })
    ).toBe(true);
    expect(isResolvedResourceReservation(reservation({ version: 3 }))).toBe(false);
    expect(isResolvedResourceReservation({ ...reservation(), cpuMillis: '1000' })).toBe(false);
  });

  it('normalizes load average to CPU percentage units', () => {
    expect(normalizeLoadAverageToCpuPercent(2, 4)).toBe(50);
    expect(normalizeLoadAverageToCpuPercent(2, null)).toBeNull();
  });

  it('rejects nodes without trusted observed hardware capacity', () => {
    const request = reservation({ memoryMb: 4096, diskMb: 40960 });
    const empty = evaluateWorkspaceReservationCapacity(
      { id: 'empty' },
      emptyUsage(),
      request,
      policy()
    );
    expect(empty.admitted).toBe(false);
    expect(empty.reasons).toContain('managed node has no provider runtime identity');

    const occupied = evaluateWorkspaceReservationCapacity(
      {
        id: 'occupied',
        providerInstanceId: 'server-occupied',
        lastMetrics: JSON.stringify({ diskPercent: 10 }),
        lastHeartbeatAt: new Date().toISOString(),
      },
      usage({ activeCount: 1, cpuMillis: 1000, memoryMb: 1024, diskMb: 1024, minMaxCoTenants: 4 }),
      request,
      policy()
    );
    expect(occupied.admitted).toBe(false);
    expect(occupied.reasons).toContain('node has no trusted observed hardware capacity');
  });

  it('reports concrete rejection diagnostics for headroom, exclusivity and disk pressure', () => {
    const now = new Date().toISOString();
    const node = {
      id: 'node',
      providerInstanceId: 'server-node',
      observedProviderInstanceVcpuCount: 4,
      observedProviderInstanceMemoryMb: 8192,
      observedProviderInstanceDiskGb: 80,
      observedHardwareSource: 'observed',
      lastHeartbeatAt: now,
      lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 95 }),
    };
    const metrics = parseWorkspaceAdmissionMetrics(node, policy());
    const result = evaluateWorkspaceReservationCapacity(
      node,
      usage({
        activeCount: 1,
        exclusiveCount: 1,
        cpuMillis: 1000,
        memoryMb: 7000,
        diskMb: 1024,
        minMaxCoTenants: 4,
      }),
      reservation({ memoryMb: 1024 }),
      policy(),
      metrics
    );

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain('existing reservation requires an exclusive node');
    expect(result.reasons).toContain('memory budget would be exceeded after host reserve');
    expect(result.reasons).toContain('disk pressure threshold reached');
  });

  it('vetoes fresh measured CPU, memory, and creating-workspace pressure separately from budgets', () => {
    const active = usage({
      activeCount: 1,
      cpuMillis: 1000,
      memoryMb: 1024,
      diskMb: 1024,
      minMaxCoTenants: 4,
    });
    const baseNode = {
      id: 'occupied',
      providerInstanceId: 'server-occupied',
      observedProviderInstanceVcpuCount: 4,
      observedProviderInstanceMemoryMb: 8192,
      observedProviderInstanceDiskGb: 80,
      observedHardwareSource: 'observed',
      lastHeartbeatAt: new Date().toISOString(),
    };

    for (const [metrics, reason] of [
      [{ cpuLoadAvg1: 8, memoryPercent: 10, diskPercent: 10 }, 'CPU pressure threshold reached'],
      [
        { cpuLoadAvg1: 0.2, memoryPercent: 99, diskPercent: 10 },
        'memory pressure threshold reached',
      ],
      [
        { cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10, creatingWorkspaces: 1 },
        'node is already creating a workspace',
      ],
    ] as const) {
      const result = evaluateWorkspaceReservationCapacity(
        { ...baseNode, lastMetrics: JSON.stringify(metrics) },
        active,
        reservation(),
        policy({ cpuThresholdPercent: 90, memoryThresholdPercent: 90 })
      );
      expect(result.admitted).toBe(false);
      expect(result.reasons).toContain(reason);
      expect(result.reasons).not.toContain('CPU share budget would be exceeded');
      expect(result.reasons).not.toContain('memory budget would be exceeded after host reserve');
    }
  });

  it('rejects malformed, future, stale, and incomplete telemetry when a node reports metrics', () => {
    const active = usage({
      activeCount: 1,
      cpuMillis: 1000,
      memoryMb: 1024,
      diskMb: 1024,
      minMaxCoTenants: 4,
    });
    const baseNode = {
      id: 'occupied',
      providerInstanceId: 'server-occupied',
      observedProviderInstanceVcpuCount: 4,
      observedProviderInstanceMemoryMb: 8192,
      observedProviderInstanceDiskGb: 80,
      observedHardwareSource: 'observed',
      lastHeartbeatAt: new Date().toISOString(),
    };

    expect(
      evaluateWorkspaceReservationCapacity(
        { ...baseNode, lastMetrics: '{"cpuLoadAvg1":"bad"}' },
        active,
        reservation(),
        policy()
      ).reasons
    ).toContain('node resource telemetry is malformed');
    expect(
      evaluateWorkspaceReservationCapacity(
        {
          ...baseNode,
          lastMetrics: JSON.stringify({
            version: 2,
            cpuLoadAvg1: 0.1,
            memoryPercent: 10,
            diskPercent: 10,
          }),
        },
        active,
        reservation(),
        policy()
      ).reasons
    ).toContain('node resource telemetry version is unsupported');
    expect(
      evaluateWorkspaceReservationCapacity(
        {
          ...baseNode,
          lastHeartbeatAt: '2026-08-28T00:00:00.000Z',
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
        },
        active,
        reservation(),
        policy(),
        parseWorkspaceAdmissionMetrics(
          {
            ...baseNode,
            lastHeartbeatAt: '2026-08-28T00:00:00.000Z',
            lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
          },
          policy(),
          new Date('2026-08-28T00:10:00.000Z').getTime()
        )
      ).reasons
    ).toContain('node telemetry is stale');
    expect(
      evaluateWorkspaceReservationCapacity(
        { ...baseNode, lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, diskPercent: 10 }) },
        active,
        reservation(),
        policy()
      ).reasons
    ).toContain('node has no memory pressure telemetry');
  });
});
