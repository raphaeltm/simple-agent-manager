import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  type ActiveWorkspaceReservationUsage,
  aggregateWorkspaceReservationRows,
  emptyUsage,
  evaluateWorkspaceReservationCapacity,
  hasWorkspaceReservationCapacity,
  isResolvedResourceReservation,
  normalizeLoadAverageToCpuPercent,
  parseResolvedResourceReservation,
  parseWorkspaceAdmissionMetrics,
  resolveWorkspaceAdmissionPolicy,
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
      [{ cpuLoadAvg1: 8, memoryPercent: 10, diskPercent: 10 }, 'CPU saturation ceiling reached'],
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

const REQUEST: ResolvedResourceReservation = {
  cpuMillis: 2_000,
  memoryMb: 4_096,
  diskMb: 40_960,
  exclusiveNode: false,
  maxCoTenants: 4,
  source: 'platform',
  sourceId: 'platform',
  version: 1,
};

const observedNode = {
  id: 'node-aggregate',
  providerInstanceId: 'server-aggregate',
  observedHardwareSource: 'observed',
  lastHeartbeatAt: new Date().toISOString(),
  lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
};

const CX23 = {
  ...observedNode,
  observedProviderInstanceVcpuCount: 2,
  observedProviderInstanceMemoryMb: 4_096,
  observedProviderInstanceDiskGb: 40,
};

describe('workspace resource capacity', () => {
  it('parses only complete integer reservation snapshots', () => {
    expect(parseResolvedResourceReservation(JSON.stringify(REQUEST))).toEqual(REQUEST);
    expect(parseResolvedResourceReservation(null)).toBeNull();
    expect(parseResolvedResourceReservation('{broken')).toBeNull();
    expect(
      parseResolvedResourceReservation(JSON.stringify({ ...REQUEST, memoryMb: '4096' }))
    ).toBeNull();
    expect(
      parseResolvedResourceReservation(JSON.stringify({ ...REQUEST, exclusiveNode: 0 }))
    ).toBeNull();
  });

  it('sums complete active reservations and marks malformed rows unknown', () => {
    expect(
      aggregateWorkspaceReservationRows([
        { resolvedReservationJson: JSON.stringify(REQUEST) },
        {
          resolvedReservationJson: JSON.stringify({
            ...REQUEST,
            cpuMillis: 1_000,
            memoryMb: 2_048,
            diskMb: 20_480,
            maxCoTenants: 2,
          }),
        },
        { resolvedReservationJson: null },
      ])
    ).toEqual({
      activeCount: 3,
      cpuMillis: 3_000,
      memoryMb: 6_144,
      diskMb: 61_440,
      exclusiveCount: 0,
      invalidCount: 1,
      minMaxCoTenants: 2,
    });
  });

  it('enforces aggregate resources and exclusivity independently of the count cap', () => {
    const occupied = aggregateWorkspaceReservationRows([
      { resolvedReservationJson: JSON.stringify(REQUEST) },
    ]);
    expect(
      hasWorkspaceReservationCapacity(
        CX23,
        occupied,
        REQUEST,
        policy({ maxWorkspaces: 4, hostMemoryReserveMb: 0 })
      )
    ).toBe(false);
    expect(
      hasWorkspaceReservationCapacity(
        {
          ...observedNode,
          observedProviderInstanceVcpuCount: 4,
          observedProviderInstanceMemoryMb: 8_192,
          observedProviderInstanceDiskGb: 80,
        },
        occupied,
        REQUEST,
        policy({ maxWorkspaces: 4, hostMemoryReserveMb: 0 })
      )
    ).toBe(true);
    expect(
      hasWorkspaceReservationCapacity(
        {
          ...observedNode,
          observedProviderInstanceVcpuCount: 8,
          observedProviderInstanceMemoryMb: 16_384,
          observedProviderInstanceDiskGb: 160,
        },
        occupied,
        { ...REQUEST, exclusiveNode: true, maxCoTenants: 1 },
        policy({ maxWorkspaces: 10, hostMemoryReserveMb: 0 })
      )
    ).toBe(false);
  });

  it('enforces both the platform count cap and every reservation co-tenant cap', () => {
    const occupied = aggregateWorkspaceReservationRows([
      { resolvedReservationJson: JSON.stringify({ ...REQUEST, maxCoTenants: 2 }) },
    ]);
    const largeNode = {
      ...observedNode,
      observedProviderInstanceVcpuCount: 8,
      observedProviderInstanceMemoryMb: 16_384,
      observedProviderInstanceDiskGb: 160,
    };

    expect(
      hasWorkspaceReservationCapacity(
        largeNode,
        occupied,
        REQUEST,
        policy({ maxWorkspaces: 1, hostMemoryReserveMb: 0 })
      )
    ).toBe(false);
    expect(
      hasWorkspaceReservationCapacity(
        largeNode,
        occupied,
        REQUEST,
        policy({ maxWorkspaces: 10, hostMemoryReserveMb: 0 })
      )
    ).toBe(true);
    expect(
      hasWorkspaceReservationCapacity(
        largeNode,
        occupied,
        { ...REQUEST, maxCoTenants: 1 },
        policy({ maxWorkspaces: 10, hostMemoryReserveMb: 0 })
      )
    ).toBe(false);
    expect(
      hasWorkspaceReservationCapacity(
        largeNode,
        aggregateWorkspaceReservationRows([
          { resolvedReservationJson: JSON.stringify({ ...REQUEST, maxCoTenants: 1 }) },
        ]),
        REQUEST,
        policy({ maxWorkspaces: 10, hostMemoryReserveMb: 0 })
      )
    ).toBe(false);
  });

  it('treats missing disk capacity conservatively once a node is occupied', () => {
    const occupied = aggregateWorkspaceReservationRows([
      { resolvedReservationJson: JSON.stringify(REQUEST) },
    ]);
    expect(
      hasWorkspaceReservationCapacity(
        {
          ...observedNode,
          observedProviderInstanceVcpuCount: 8,
          observedProviderInstanceMemoryMb: 16_384,
          observedProviderInstanceDiskGb: null,
        },
        occupied,
        REQUEST,
        policy({ maxWorkspaces: 10, hostMemoryReserveMb: 0 })
      )
    ).toBe(false);
  });
});

describe('live CPU is a saturation ceiling, not an admission authority', () => {
  // Production sets none of these, so the resolved defaults are what actually
  // decide admission there. Reaching the defaults through the real resolver is
  // the only way to observe the incident (.claude/rules/62).
  const productionEnv = {} as Parameters<typeof resolveWorkspaceAdmissionPolicy>[0];

  /** `cpuLoadAvg1 / vcpu * 100`, so 2.4 over 4 vCPU is 60%. */
  function hostAt(cpuPercent: number, overrides: Record<string, unknown> = {}) {
    return {
      id: 'occupied',
      providerInstanceId: 'server-occupied',
      observedProviderInstanceVcpuCount: 4,
      observedProviderInstanceMemoryMb: 8192,
      observedProviderInstanceDiskGb: 80,
      observedHardwareSource: 'observed',
      lastHeartbeatAt: new Date().toISOString(),
      lastMetrics: JSON.stringify({
        cpuLoadAvg1: (cpuPercent / 100) * 4,
        memoryPercent: 10,
        diskPercent: 10,
        ...overrides,
      }),
    };
  }

  const oneCoTenant = () =>
    usage({ activeCount: 1, cpuMillis: 1000, memoryMb: 1024, diskMb: 1024, minMaxCoTenants: 4 });

  it('admits a busy-but-unsaturated host whose declared budget still fits', () => {
    // The incident: at the previous 50% default this host was refused and the
    // scheduler bought another VM, even though 3000 of its 4000 declared
    // milliCPU were free. Fails against pre-fix code.
    const result = evaluateWorkspaceReservationCapacity(
      hostAt(60),
      oneCoTenant(),
      reservation({ cpuMillis: 1000 }),
      resolveWorkspaceAdmissionPolicy(productionEnv)
    );

    expect(result.reasons).toEqual([]);
    expect(result.admitted).toBe(true);
  });

  it('still refuses the same host when the declared budget does not fit', () => {
    // Control: admission did not simply get weaker. The declared reservation is
    // now the sole CPU authority below saturation, so it must still bite.
    const result = evaluateWorkspaceReservationCapacity(
      hostAt(60),
      oneCoTenant(),
      reservation({ cpuMillis: 3500 }),
      resolveWorkspaceAdmissionPolicy(productionEnv)
    );

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain('CPU share budget would be exceeded');
    expect(result.reasons).not.toContain('CPU saturation ceiling reached');
  });

  it('still refuses a genuinely saturated host', () => {
    const result = evaluateWorkspaceReservationCapacity(
      hostAt(96),
      oneCoTenant(),
      reservation({ cpuMillis: 1000 }),
      resolveWorkspaceAdmissionPolicy(productionEnv)
    );

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain('CPU saturation ceiling reached');
  });

  it.each([
    ['memory', { memoryPercent: 99 }, 'memory pressure threshold reached'],
    ['disk', { diskPercent: 99 }, 'disk pressure threshold reached'],
  ])('keeps the non-compressible %s veto at the same pressure', (_label, overrides, reason) => {
    // Memory and disk oversubscription gets processes OOM-killed and wedges the
    // node, so neither may follow CPU up to a saturation-only ceiling.
    const result = evaluateWorkspaceReservationCapacity(
      hostAt(10, overrides),
      oneCoTenant(),
      reservation({ cpuMillis: 1000 }),
      resolveWorkspaceAdmissionPolicy(productionEnv)
    );

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it('lets a project override tighten the ceiling back down', () => {
    const result = evaluateWorkspaceReservationCapacity(
      hostAt(60),
      oneCoTenant(),
      reservation({ cpuMillis: 1000 }),
      resolveWorkspaceAdmissionPolicy(productionEnv, { nodeCpuThresholdPercent: 50 })
    );

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain('CPU saturation ceiling reached');
  });
});
