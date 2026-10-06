import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_BUDGET_EXCEEDED, getConfig, main, parseCostResponse } from './check-cloudflare-cost';
import {
  analyzeCloudflareCost,
  calculateProjectedCost,
  createDefaultPricing,
  type CloudflareCostRows,
  formatCostReport,
  validateDurationIdentity,
} from './cloudflare-cost-core';

const EMPTY_ROWS: CloudflareCostRows = {
  durableObjectPeriodic: [],
  durableObjectInvocations: [],
  workersAi: [],
  r2Storage: [],
  d1Analytics: [],
  d1Storage: [],
  containers: [],
};

describe('check-cloudflare-cost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CF_PRODUCTION_DEBUGGING_TOKEN;
    delete process.env.CF_PRODUCTION_ACCOUNT_ID;
  });

  it('calculates allowance boundaries without charging included usage', () => {
    const pricing = createDefaultPricing().metrics.doRowsRead;

    expect(calculateProjectedCost(25_000_000_000, pricing)).toBe(0);
    expect(calculateProjectedCost(26_000_000_000, pricing)).toBeCloseTo(1);
  });

  it('validates the Durable Object activeTime to billed duration identity', () => {
    expect(
      validateDurationIdentity({
        dimensions: { date: '2026-09-21', namespaceId: 'namespace-a' },
        sum: { activeTime: 71_190_867, duration: 9.112430976 },
      })
    ).toBeNull();

    expect(
      validateDurationIdentity({
        dimensions: { date: '2026-09-21', namespaceId: 'namespace-a' },
        sum: { activeTime: 71_190_867, duration: 99 },
      })
    ).toContain('does not equal activeTime/1e6*0.128');
  });

  it('does not let hibernating WebSocket wallTime influence DO duration cost', () => {
    const analysis = analyzeCloudflareCost(
      {
        ...EMPTY_ROWS,
        durableObjectPeriodic: [
          {
            dimensions: {
              date: '2026-09-01',
              namespaceId: 'notification',
              name: 'NotificationService',
            },
            sum: { activeTime: 75_781, duration: 0.0097, rowsRead: 0, rowsWritten: 0 },
          },
        ],
        durableObjectInvocations: [
          {
            dimensions: {
              date: '2026-09-01',
              namespaceId: 'notification',
              scriptName: 'sam-api-prod',
              type: 'websocket',
            },
            sum: { requests: 10, wallTime: 51 * 60 * 60 * 1_000_000 },
          },
        ],
      },
      createDefaultPricing(),
      { startDate: '2026-09-01', endDate: '2026-09-01', recentDays: 1 }
    );

    const duration = analysis.projections.find(
      (projection) => projection.key === 'doDurationGbSeconds'
    );
    expect(duration?.projectedCostUsd).toBe(0);
    expect(duration?.monthToDateUsage).toBeCloseTo(0.0097);
  });

  it('projects September rows-read from the recent rate instead of calling the month climbing', () => {
    const rowsRead = [
      4_415_000_000,
      4_415_000_000,
      4_415_000_000,
      4_415_000_000,
      ...Array.from({ length: 17 }, () => 200_000_000),
    ];
    const durableObjectPeriodic = rowsRead.map((value, index) => {
      const day = String(index + 1).padStart(2, '0');
      return {
        dimensions: { date: `2026-09-${day}`, namespaceId: 'project-data', name: `object-${day}` },
        sum: {
          activeTime: 0,
          duration: 0,
          rowsRead: value,
          rowsWritten: 0,
          storageReadUnits: 0,
          storageWriteUnits: 0,
        },
      };
    });

    const analysis = analyzeCloudflareCost(
      { ...EMPTY_ROWS, durableObjectPeriodic },
      createDefaultPricing(),
      { startDate: '2026-09-01', endDate: '2026-09-21', recentDays: 7 }
    );
    const rowsReadProjection = analysis.projections.find(
      (projection) => projection.key === 'doRowsRead'
    );
    const report = formatCostReport(analysis, {
      startDate: '2026-09-01',
      endDate: '2026-09-21',
      recentDays: 7,
    });

    expect(rowsReadProjection?.projectedUsage).toBe(22_860_000_000);
    expect(rowsReadProjection?.projectedCostUsd).toBe(0);
    expect(rowsReadProjection?.trend).toBe('early-spike');
    expect(report).not.toContain('climbing');
    expect(report).toContain('early spike; recent rate lower');
  });

  it('fails closed when production credentials are missing', () => {
    expect(() => getConfig([], new Date('2026-09-21T12:00:00Z'))).toThrow(
      'CF_PRODUCTION_DEBUGGING_TOKEN is required'
    );
  });

  it('defaults to the last complete UTC day for projection windows', () => {
    process.env.CF_PRODUCTION_DEBUGGING_TOKEN = 'token';
    process.env.CF_PRODUCTION_ACCOUNT_ID = 'account';

    expect(getConfig([], new Date('2026-09-21T12:00:00Z')).endDate).toBe('2026-09-20');
  });

  it('propagates GraphQL errors and refuses partial-looking limit hits', () => {
    expect(() => parseCostResponse({ errors: [{ message: 'bad field' }] }, 10)).toThrow(
      'Cloudflare GraphQL error: bad field'
    );

    expect(() =>
      parseCostResponse(
        {
          data: {
            viewer: {
              accounts: [
                {
                  durableObjectsPeriodicGroups: Array.from({ length: 2 }, () => ({
                    dimensions: { date: '2026-09-21' },
                    sum: { duration: 1 },
                  })),
                },
              ],
            },
          },
        },
        2
      )
    ).toThrow('refusing a partial cost report');
  });

  it('returns a budget failure when --max-usd is exceeded', async () => {
    process.env.CF_PRODUCTION_DEBUGGING_TOKEN = 'token';
    process.env.CF_PRODUCTION_ACCOUNT_ID = 'account';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            viewer: {
              accounts: [
                {
                  durableObjectsPeriodicGroups: [
                    {
                      dimensions: {
                        date: '2026-09-21',
                        namespaceId: 'project-data',
                        name: 'object',
                      },
                      sum: { activeTime: 0, duration: 0, rowsRead: 30_000_000_000, rowsWritten: 0 },
                    },
                  ],
                },
              ],
            },
          },
        }),
      }))
    );

    await expect(
      main(['--start-date=2026-09-21', '--end-date=2026-09-21', '--max-usd=0'])
    ).resolves.toBe(EXIT_BUDGET_EXCEEDED);
  });
});
