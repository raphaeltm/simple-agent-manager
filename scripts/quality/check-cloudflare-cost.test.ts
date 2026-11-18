import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analyzeCloudflareCost,
  calculateCloudflareMetricCost,
  type CloudflareCostRows,
  createCloudflarePricing,
  parseCloudflareCostResponse,
  validateDurationIdentity,
} from '../../packages/shared/src/cloudflare-cost/index.js';
import { EXIT_BUDGET_EXCEEDED, getConfig, main } from './check-cloudflare-cost';
import { formatCostReport } from './cloudflare-cost-report';

const EMPTY_ROWS: CloudflareCostRows = {
  durableObjectPeriodic: [],
  durableObjectInvocations: [],
  workersInvocations: [],
  kvOperations: [],
  kvStorage: [],
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
    const pricing = createCloudflarePricing().metrics.doRowsRead;

    expect(calculateCloudflareMetricCost(25_000_000_000, pricing)).toBe(0);
    expect(calculateCloudflareMetricCost(26_000_000_000, pricing)).toBeCloseTo(1);
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
            dimensions: { date: '2026-09-01' },
            // wallTime is deliberately present: the analysis must ignore it (rule 76.3).
            sum: { requests: 10, wallTime: 51 * 60 * 60 * 1_000_000 } as { requests: number },
          },
        ],
      },
      createCloudflarePricing(),
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
      createCloudflarePricing(),
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
    expect(() => parseCloudflareCostResponse({ errors: [{ message: 'bad field' }] }, 10)).toThrow(
      'Cloudflare GraphQL error: bad field'
    );

    expect(() =>
      parseCloudflareCostResponse(
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
    ).toThrow('refusing a partial cost estimate');
  });

  it('excludes tail-worker invocations from Workers requests but keeps their CPU time', () => {
    const analysis = analyzeCloudflareCost(
      {
        ...EMPTY_ROWS,
        workersInvocations: [
          {
            dimensions: { date: '2026-11-15', eventType: 'fetch' },
            sum: { requests: 260_706, cpuTimeUs: 2_949_020_908 },
          },
          {
            dimensions: { date: '2026-11-15', eventType: 'cron' },
            sum: { requests: 311, cpuTimeUs: 224_486_837 },
          },
          {
            dimensions: { date: '2026-11-15', eventType: 'tail' },
            sum: { requests: 590_939, cpuTimeUs: 113_113_779 },
          },
        ],
      },
      createCloudflarePricing(),
      { startDate: '2026-11-01', endDate: '2026-11-15', recentDays: 7 }
    );
    const day = analysis.daily.find((entry) => entry.date === '2026-11-15');
    expect(day?.metrics.workersRequests).toBe(261_017);
    expect(day?.metrics.workersCpuMs).toBeCloseTo(
      (2_949_020_908 + 224_486_837 + 113_113_779) / 1000
    );
  });

  it('maps KV actions and sums KV storage across namespaces', () => {
    const analysis = analyzeCloudflareCost(
      {
        ...EMPTY_ROWS,
        kvOperations: [
          { dimensions: { date: '2026-11-15', actionType: 'read' }, sum: { requests: 45_849 } },
          { dimensions: { date: '2026-11-15', actionType: 'write' }, sum: { requests: 3_516 } },
          { dimensions: { date: '2026-11-15', actionType: 'delete' }, sum: { requests: 2 } },
          { dimensions: { date: '2026-11-15', actionType: 'list' }, sum: { requests: 7 } },
          { dimensions: { date: '2026-11-15', actionType: 'unknown' }, sum: { requests: 99 } },
        ],
        kvStorage: [
          { dimensions: { date: '2026-11-15', namespaceId: 'a' }, max: { byteCount: 732_963 } },
          { dimensions: { date: '2026-11-15', namespaceId: 'b' }, max: { byteCount: 23_744 } },
        ],
      },
      createCloudflarePricing(),
      { startDate: '2026-11-15', endDate: '2026-11-15', recentDays: 1 }
    );
    const metrics = analysis.daily[0]?.metrics;
    expect(metrics?.kvReads).toBe(45_849);
    expect(metrics?.kvWrites).toBe(3_516);
    expect(metrics?.kvDeletes).toBe(2);
    expect(metrics?.kvLists).toBe(7);
    expect(metrics?.kvStorageGb).toBeCloseTo((732_963 + 23_744) / 1e9);
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
