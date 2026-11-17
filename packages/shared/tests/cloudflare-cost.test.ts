/**
 * The shared Cloudflare cost core (`.claude/rules/76`), used by `pnpm quality:cloudflare-cost` and
 * the API Worker's daily snapshot: pricing, per-day costs, the analysis of each billed dataset,
 * month projections, and the GraphQL query and its parser.
 */
import { describe, expect, it } from 'vitest';

import {
  analyzeCloudflareCost,
  buildCloudflareCostQuery,
  calculateCloudflareMetricCost,
  CLOUDFLARE_COST_METRIC_KEYS,
  cloudflareCostHttpError,
  cloudflareCostQueryBody,
  CloudflareCostQueryError,
  cloudflareDaysInMonth,
  createCloudflarePricing,
  dailyCloudflareMetricCosts,
  isCloudflareCostMetricKey,
  parseCloudflareCostResponse,
  projectCloudflareMetric,
  validateDurationIdentity,
} from '../src/cloudflare-cost';

const pricing = createCloudflarePricing();

describe('pricing', () => {
  it('prices usage above the allowance only', () => {
    expect(calculateCloudflareMetricCost(10_000_000, pricing.metrics.workersRequests)).toBe(0);
    expect(calculateCloudflareMetricCost(12_000_000, pricing.metrics.workersRequests)).toBeCloseTo(
      0.6
    );
    expect(createCloudflarePricing({ workersRequests: 0 }).metrics.workersRequests.allowance).toBe(
      0
    );
  });

  it('spends a cumulative allowance on the earliest days and sums to the month cost', () => {
    const metric = pricing.metrics.doRowsWritten; // 50M free, $1 per million
    const costs = dailyCloudflareMetricCosts([30e6, 30e6, 5e6], metric, 30);
    expect(costs[0]).toBe(0);
    expect(costs[1]).toBeCloseTo(10);
    expect(costs[2]).toBeCloseTo(5);
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(
      calculateCloudflareMetricCost(65e6, metric)
    );
  });

  it('prices a daily allowance per day and storage at a share of the month', () => {
    expect(
      dailyCloudflareMetricCosts([21_000, 5_000], pricing.metrics.workersAiNeurons, 30)
    ).toEqual([expect.closeTo(0.121, 6), 0]);
    const storage = dailyCloudflareMetricCosts([15, 5], pricing.metrics.d1StorageGb, 30);
    expect(storage[0]).toBeCloseTo((10 * 0.75) / 30);
    expect(storage[1]).toBe(0);
  });

  it('knows the length of every month', () => {
    expect(cloudflareDaysInMonth('2026-11-16')).toBe(30);
    expect(cloudflareDaysInMonth('2028-02-01')).toBe(29);
    expect(isCloudflareCostMetricKey('kvReads')).toBe(true);
    expect(isCloudflareCostMetricKey('wallTime')).toBe(false);
    expect(CLOUDFLARE_COST_METRIC_KEYS).toHaveLength(19);
  });
});

describe('analyzeCloudflareCost', () => {
  it('maps every billed dataset to its metric for the day', () => {
    const day = '2026-11-15';
    const analysis = analyzeCloudflareCost(
      {
        durableObjectPeriodic: [
          {
            dimensions: { date: day, namespaceId: 'ns', name: 'obj' },
            sum: {
              activeTime: 1_000_000,
              duration: 0.128,
              rowsRead: 5,
              rowsWritten: 6,
              storageReadUnits: 7,
              storageWriteUnits: 8,
            },
          },
          { dimensions: { date: '2026-12-01' }, sum: { duration: 99 } },
        ],
        durableObjectInvocations: [{ dimensions: { date: day }, sum: { requests: 9 } }],
        workersInvocations: [
          { dimensions: { date: day, eventType: 'fetch' }, sum: { requests: 10, cpuTimeUs: 2000 } },
          { dimensions: { date: day, eventType: 'tail' }, sum: { requests: 99, cpuTimeUs: 1000 } },
        ],
        kvOperations: [
          { dimensions: { date: day, actionType: 'read' }, sum: { requests: 11 } },
          { dimensions: { date: day, actionType: 'list' }, sum: { requests: 12 } },
        ],
        kvStorage: [{ dimensions: { date: day, namespaceId: 'a' }, max: { byteCount: 2e9 } }],
        workersAi: [{ dimensions: { date: day }, sum: { totalNeurons: 13 } }],
        r2Storage: [
          { dimensions: { date: day }, max: { payloadSize: 3e9, metadataSize: 1e9 } },
          { dimensions: { date: null }, max: { payloadSize: 1e12 } },
        ],
        d1Analytics: [{ dimensions: { date: day }, sum: { rowsRead: 14, rowsWritten: 15 } }],
        d1Storage: [{ dimensions: { date: day }, max: { databaseSizeBytes: 5e9 } }],
        containers: [{ dimensions: { date: day }, sum: { allocatedMemory: 1024 ** 3 * 16 } }],
      },
      pricing,
      { startDate: '2026-11-01', endDate: day }
    );
    const metrics = analysis.daily.at(-1)?.metrics;

    expect(metrics).toMatchObject({
      doDurationGbSeconds: 0.128,
      doRowsRead: 5,
      doRowsWritten: 6,
      doStorageReadUnits: 7,
      doStorageWriteUnits: 8,
      doRequests: 9,
      workersRequests: 10,
      workersCpuMs: 3,
      kvReads: 11,
      kvLists: 12,
      kvStorageGb: 2,
      workersAiNeurons: 13,
      r2StorageGb: 4,
      d1RowsRead: 14,
      d1RowsWritten: 15,
      d1StorageGb: 5,
      containerMemoryGibSeconds: 16,
    });
    expect(analysis.daily).toHaveLength(15);
    expect(analysis.durableObjectNamespaces.find((ns) => ns.namespaceId === 'ns')).toMatchObject({
      namespaceId: 'ns',
      sampleObjectName: 'obj',
    });
    expect(analysis.durationIdentityViolations).toEqual([expect.stringContaining('2026-12-01')]);
    expect(analysis.totalProjectedUsd).toBeGreaterThan(0);
  });

  it('checks the billed-duration identity', () => {
    expect(validateDurationIdentity({ dimensions: {}, sum: null })).toBeNull();
    expect(
      validateDurationIdentity({ dimensions: {}, sum: { activeTime: 1e6, duration: 0.128 } })
    ).toBeNull();
  });
});

describe('projectCloudflareMetric', () => {
  const days = (values: number[]) => values;

  it('projects cumulative usage from the recent rate and calls an early spike', () => {
    const values = days([100, 100, 100, 100, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const projection = projectCloudflareMetric(values, '2026-11-01', pricing.metrics.kvWrites, 7);
    expect(projection.projectedUsage).toBe(410 + 16);
    expect(projection.trend).toBe('early-spike');
  });

  it('calls a rising rate climbing and a flat one steady', () => {
    const climbing = projectCloudflareMetric(
      [1, 1, 1, 1, 1, 1, 1, 10, 10, 10, 10, 10, 10, 10],
      '2026-11-01',
      pricing.metrics.kvWrites,
      7
    );
    expect(climbing.trend).toBe('climbing');
    const steady = projectCloudflareMetric(
      [5, 5, 5, 5, 5],
      '2026-11-01',
      pricing.metrics.kvWrites,
      7
    );
    expect(steady.trend).toBe('steady');
  });

  it('projects a daily allowance day by day', () => {
    const projection = projectCloudflareMetric(
      [20_000, 20_000],
      '2026-11-01',
      pricing.metrics.workersAiNeurons,
      2
    );
    // 10k billable a day for 30 days at $0.011 per 1k.
    expect(projection.projectedCostUsd).toBeCloseTo(3.3, 6);
    expect(projection.allowance).toBe(300_000);
  });

  it('keeps storage that shrank late in the month: accrued days plus the latest level', () => {
    // D1 storage 105 GB for 29 days, then 5 GB on the 30th (allowance 5 GB, $0.75 per GB-month).
    const complete = [...Array.from({ length: 29 }, () => 105), 5];
    const finished = projectCloudflareMetric(
      complete,
      '2026-11-30',
      pricing.metrics.d1StorageGb,
      7
    );
    expect(finished.projectedCostUsd).toBeCloseTo((100 * 0.75 * 29) / 30, 6); // $72.50
    expect(finished.monthToDateUsage).toBe(5);

    // Mid-month: 10 days at 105 GB, then 20 remaining days at the latest level (105 GB).
    const partial = Array.from({ length: 10 }, () => 105);
    const midMonth = projectCloudflareMetric(partial, '2026-11-10', pricing.metrics.d1StorageGb, 7);
    expect(midMonth.projectedCostUsd).toBeCloseTo(75, 6);
  });
});

describe('Cloudflare GraphQL query', () => {
  it('groups by date only unless the namespace breakdown is asked for', () => {
    expect(buildCloudflareCostQuery()).toContain('dimensions { date }');
    expect(buildCloudflareCostQuery({ durableObjectBreakdown: true })).toContain(
      'date namespaceId name'
    );
    for (const query of [
      buildCloudflareCostQuery(),
      buildCloudflareCostQuery({ durableObjectBreakdown: true }),
    ]) {
      expect(query).not.toContain('wallTime');
      expect(query).toContain('eventType');
    }
    const body = JSON.parse(
      cloudflareCostQueryBody({ accountId: 'acct', startDate: 'a', endDate: 'b', limit: 5 })
    ) as { variables: Record<string, unknown> };
    expect(body.variables).toEqual({ accountTag: 'acct', start: 'a', end: 'b', limit: 5 });
  });

  it('classifies HTTP failures by what the operator must do', () => {
    expect(cloudflareCostHttpError(403).kind).toBe('permission');
    expect(cloudflareCostHttpError(502).kind).toBe('failed');
    expect(
      cloudflareCostHttpError(400, { errors: [{ code: 9106, message: 'Authentication failed' }] })
        .kind
    ).toBe('permission');
    expect(cloudflareCostHttpError(403, { errors: [{ message: 'odd' }] }).kind).toBe('permission');
    expect(cloudflareCostHttpError(500, { errors: [{ message: 'boom' }] }).message).toContain(
      'HTTP 500'
    );
  });

  it('parses rows and refuses every partial or malformed answer', () => {
    const ok = parseCloudflareCostResponse(
      {
        data: {
          viewer: {
            accounts: [
              {
                d1AnalyticsAdaptiveGroups: [{ dimensions: { date: 'x' } }],
                kvStorageAdaptiveGroups: null,
              },
            ],
          },
        },
      },
      10
    );
    expect(ok.d1Analytics).toHaveLength(1);
    expect(ok.kvStorage).toEqual([]);

    const kind = (payload: unknown, limit = 10) => {
      try {
        parseCloudflareCostResponse(payload, limit);
        return 'parsed';
      } catch (error) {
        return error instanceof CloudflareCostQueryError ? error.kind : 'other';
      }
    };
    expect(kind('nope')).toBe('failed');
    expect(kind({ errors: [{ extensions: { code: 'authz' }, message: 'x' }] })).toBe('permission');
    expect(kind({ errors: [{ extensions: { code: 'quota' }, message: 'too wide' }] })).toBe(
      'range'
    );
    expect(kind({ errors: [{ message: 'bad field' }] })).toBe('failed');
    expect(kind({ data: { viewer: { accounts: [] } } })).toBe('permission');
    expect(
      kind({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: { rows: [] } }] } } })
    ).toBe('failed');
    expect(
      kind({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{}, {}] }] } } }, 2)
    ).toBe('truncated');
  });
});
