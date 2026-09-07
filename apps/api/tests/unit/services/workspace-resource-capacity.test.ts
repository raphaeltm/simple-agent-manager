import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  type ActiveWorkspaceReservationUsage,
  emptyUsage,
  evaluateWorkspaceReservationCapacity,
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
  it('normalizes load average to CPU percentage units', () => {
    expect(normalizeLoadAverageToCpuPercent(2, 4)).toBe(50);
    expect(normalizeLoadAverageToCpuPercent(2, null)).toBeNull();
  });

  it('admits an empty unknown-capacity node while fail-closing occupied unknown capacity', () => {
    const request = reservation({ memoryMb: 4096, diskMb: 40960 });
    expect(
      evaluateWorkspaceReservationCapacity({ id: 'empty' }, emptyUsage(), request, policy())
        .admitted
    ).toBe(true);

    const occupied = evaluateWorkspaceReservationCapacity(
      {
        id: 'occupied',
        lastMetrics: JSON.stringify({ diskPercent: 10 }),
        lastHeartbeatAt: new Date().toISOString(),
      },
      usage({ activeCount: 1, cpuMillis: 1000, memoryMb: 1024, diskMb: 1024, minMaxCoTenants: 4 }),
      request,
      policy()
    );
    expect(occupied.admitted).toBe(false);
    expect(occupied.reasons).toContain('occupied node has unknown CPU capacity');
    expect(occupied.reasons).toContain('occupied node has unknown memory capacity');
    expect(occupied.reasons).toContain('occupied node has unknown disk capacity');
  });

  it('reports concrete rejection diagnostics for headroom, exclusivity and disk pressure', () => {
    const now = new Date().toISOString();
    const metrics = parseWorkspaceAdmissionMetrics(
      {
        id: 'node',
        providerInstanceVcpuCount: 4,
        providerInstanceMemoryMb: 8192,
        providerInstanceDiskGb: 80,
        lastHeartbeatAt: now,
        lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 95 }),
      },
      policy()
    );
    const result = evaluateWorkspaceReservationCapacity(
      {
        id: 'node',
        providerInstanceVcpuCount: 4,
        providerInstanceMemoryMb: 8192,
        providerInstanceDiskGb: 80,
        lastHeartbeatAt: now,
        lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 95 }),
      },
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
});
