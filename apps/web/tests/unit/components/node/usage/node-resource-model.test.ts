import type { NodeResponse } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  formatVcpu,
  latest,
  liveMemoryByWorkspace,
  machineSpec,
  sessionNow,
  sumSeries,
} from '../../../../../src/components/node/usage/node-resource-model';

const baseNode = {
  id: 'n',
  name: 'Auto: some task title',
  status: 'running',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  nodeRole: 'workspace',
  ipAddress: null,
  lastHeartbeatAt: null,
  errorMessage: null,
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
} as NodeResponse;

describe('node resource model', () => {
  it('names a machine by provider and observed type, preferring observed hardware over configured', () => {
    const spec = machineSpec({
      ...baseNode,
      cloudProvider: 'hetzner',
      providerInstanceType: 'cx43',
      providerInstanceVcpuCount: 8,
      providerInstanceMemoryMb: 16384,
      observedProviderInstanceType: 'cx53',
      observedProviderInstanceVcpuCount: 16,
      observedProviderInstanceMemoryMb: 32768,
    });
    expect(spec.title).toBe('Hetzner cx53');
    expect(spec.vcpu).toBe(16);
    expect(spec.memoryMb).toBe(32768);
    // No hardware at all: fall back to the stored name rather than an empty title.
    expect(machineSpec(baseNode).title).toBe('Auto: some task title');
    expect(
      machineSpec({
        ...baseNode,
        cloudProvider: 'cloudflare' as never,
        providerInstanceType: 'cf-container',
      })
    ).toMatchObject({ title: 'Instant container', location: 'Cloudflare' });
  });

  it('sums sessions per bucket start and keeps a bucket only one session reported', () => {
    const total = sumSeries([
      { start: [0, 60_000], cpuMillis: [100, 200], memoryBytes: [10, null] },
      { start: [60_000, 120_000], cpuMillis: [300, null], memoryBytes: [30, 40] },
    ]);
    expect(total).toEqual({
      start: [0, 60_000, 120_000],
      cpuMillis: [100, 500, null],
      memoryBytes: [10, 30, 40],
    });
  });

  it('takes the newest non-null value as "now"', () => {
    expect(latest([0, 1, 2], [5, 6, null])).toEqual({ value: 6, at: 1 });
    expect(latest([], [])).toBeNull();
  });

  it('ignores heartbeat memory once the heartbeat is stale', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const node = {
      ...baseNode,
      heartbeatStaleAfterSeconds: 180,
      lastHeartbeatAt: '2026-11-04T11:59:00Z',
      lastMetrics: {
        workspaceMemory: [
          { workspaceId: 'fresh', memoryUsageBytes: 5, collectedAt: '2026-11-04T11:59:30Z' },
          { workspaceId: 'stale', memoryUsageBytes: 7, collectedAt: '2026-11-04T11:50:00Z' },
          { workspaceId: 'heartbeat-time', memoryUsageBytes: 9 },
        ],
      },
    };
    expect([...liveMemoryByWorkspace(node, now)]).toEqual([
      ['fresh', 5],
      ['heartbeat-time', 9],
    ]);
  });

  it('treats memory over its reservation as over, and CPU over its reservation separately', () => {
    const now = sessionNow(
      {
        reservation: { cpuMillis: 1000, memoryMb: 1, diskMb: 0, exclusiveNode: false },
        series: { start: [0], cpuMillis: [1500], memoryBytes: [512 * 1024] },
      },
      2 * 1024 * 1024
    );
    expect(now).toMatchObject({
      memoryBytes: 2 * 1024 * 1024,
      memoryIsLive: true,
      memoryOver: true,
      cpuOver: true,
    });
  });

  it('formats tiny CPU readings without rounding them to zero', () => {
    expect(formatVcpu(20)).toBe('<0.1 vCPU');
    expect(formatVcpu(0)).toBe('0.0 vCPU');
    expect(formatVcpu(12_400)).toBe('12 vCPU');
  });
});
