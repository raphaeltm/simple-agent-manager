import { describe, expect, it } from 'vitest';

import { calculateNodeUsageTotalsForRows } from '../../../src/services/node-usage';

describe('node usage calculations', () => {
  it('counts idle platform node lifetime as billable vCPU-hours', () => {
    const totals = calculateNodeUsageTotalsForRows(
      [
        {
          vmSize: 'small',
          cloudProvider: 'hetzner',
          credentialSource: 'platform',
          status: 'running',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-01T04:00:00.000Z'),
      new Date('2026-05-01T04:00:00.000Z'),
    );

    expect(totals.platformNodeHours).toBe(4);
    expect(totals.platformVcpuHours).toBe(8);
    expect(totals.totalVcpuHours).toBe(8);
    expect(totals.activeNodes).toBe(1);
  });

  it('excludes BYOC node time from platform quota totals', () => {
    const totals = calculateNodeUsageTotalsForRows(
      [
        {
          vmSize: 'small',
          cloudProvider: 'hetzner',
          credentialSource: 'user',
          status: 'running',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-01T04:00:00.000Z'),
      new Date('2026-05-01T04:00:00.000Z'),
    );

    expect(totals.platformVcpuHours).toBe(0);
    expect(totals.userVcpuHours).toBe(8);
    expect(totals.totalVcpuHours).toBe(8);
  });

  it('clamps destroyed nodes to the requested period', () => {
    const totals = calculateNodeUsageTotalsForRows(
      [
        {
          vmSize: 'medium',
          cloudProvider: 'hetzner',
          credentialSource: 'platform',
          status: 'destroyed',
          createdAt: '2026-04-30T22:00:00.000Z',
          updatedAt: '2026-05-01T02:00:00.000Z',
        },
      ],
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-01T04:00:00.000Z'),
      new Date('2026-05-01T04:00:00.000Z'),
    );

    expect(totals.platformNodeHours).toBe(2);
    expect(totals.platformVcpuHours).toBe(8);
    expect(totals.activeNodes).toBe(0);
  });
});
