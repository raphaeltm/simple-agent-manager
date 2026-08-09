import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyzeInvocationRateRegression,
  analyzeWallTimeRegression,
  type DurableObjectWallTimeRow,
  formatReport,
  hasCronCompletedEvent,
  resolveCronLivenessScriptNames,
  summarizeInvocationRates,
  summarizeRows,
} from './check-do-wall-time';

function row(input: {
  hour: string;
  scriptName?: string;
  namespaceId?: string;
  name?: string;
  type?: string;
  p99: number | null;
  p999?: number | null;
  requests?: number;
}): DurableObjectWallTimeRow {
  return {
    dimensions: {
      datetimeHour: input.hour,
      scriptName: input.scriptName ?? 'sam-api-staging',
      namespaceId: input.namespaceId ?? 'project-data-namespace',
      name: input.name ?? 'ProjectData',
      type: input.type ?? 'alarm',
    },
    quantiles: {
      wallTimeP99: input.p99,
      wallTimeP999: input.p999 ?? input.p99,
    },
    sum: {
      requests: input.requests ?? 20,
    },
  };
}

describe('check-do-wall-time', () => {
  it('binds scheduled checks to production and supports staging pre-merge dispatches', () => {
    const workflow = readFileSync(resolve('.github/workflows/do-wall-time.yml'), 'utf8');

    expect(workflow).toContain("environment: ${{ inputs.environment || 'production' }}");
    expect(workflow).toContain('default: production');
    expect(workflow).toContain('- staging');
    expect(workflow).toContain('- production');
    expect(workflow).toContain('DO_CRON_LIVENESS_SCRIPT_NAMES');
    expect(workflow).toContain('RESOURCE_PREFIX: ${{ vars.RESOURCE_PREFIX }}');
    expect(workflow).toContain('TARGET_STACK="prod"');
    expect(workflow).toContain('TARGET_STACK="staging"');
    expect(workflow).toContain(
      'DO_WALL_TIME_SCRIPT_NAMES="${RESOURCE_PREFIX}-api-${TARGET_STACK}"'
    );
  });

  it('summarizes realistic GraphQL rows by script namespace and name', () => {
    const summaries = summarizeRows([
      row({ hour: '2026-07-02T08:00:00Z', p99: 5_000_000, requests: 10 }),
      row({ hour: '2026-07-02T09:00:00Z', p99: 7_000_000, p999: 9_000_000, requests: 15 }),
    ]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      key: 'sam-api-staging::project-data-namespace::ProjectData::alarm',
      invocationType: 'alarm',
      bucketCount: 2,
      requestCount: 25,
      averageP99Ms: 6_000,
      maxP99Ms: 7_000,
      maxP999Ms: 9_000,
    });
  });

  it('flags a recent P99 wall-time regression over baseline', () => {
    const baseline = [
      row({ hour: '2026-06-25T08:00:00Z', p99: 4_800_000, requests: 50 }),
      row({ hour: '2026-06-25T09:00:00Z', p99: 5_200_000, requests: 50 }),
    ];
    const recent = [
      row({ hour: '2026-07-02T08:00:00Z', p99: 21_000_000, requests: 50 }),
      row({ hour: '2026-07-02T09:00:00Z', p99: 19_000_000, requests: 50 }),
    ];

    const result = analyzeWallTimeRegression(recent, baseline, {
      regressionRatio: 2,
      minRequests: 10,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      recentAverageP99Ms: 20_000,
      baselineAverageP99Ms: 5_000,
      ratio: 4,
      recentRequests: 100,
      baselineRequests: 100,
    });
    expect(formatReport(result, 2)).toContain('Durable Object wall-time regressions detected: 1');
  });

  it('does not flag normal variance below the threshold', () => {
    const baseline = [row({ hour: '2026-06-25T08:00:00Z', p99: 5_000_000, requests: 40 })];
    const recent = [row({ hour: '2026-07-02T08:00:00Z', p99: 7_000_000, requests: 40 })];

    const result = analyzeWallTimeRegression(recent, baseline, {
      regressionRatio: 2,
      minRequests: 10,
    });

    expect(result.findings).toHaveLength(0);
    expect(formatReport(result, 2)).toContain('No Durable Object wall-time regressions detected');
  });

  it('does not false-positive when data is empty or missing baseline', () => {
    const empty = analyzeWallTimeRegression([], [], {
      regressionRatio: 2,
      minRequests: 10,
    });
    expect(empty.findings).toHaveLength(0);
    expect(empty.recentSeries).toHaveLength(0);
    expect(empty.baselineSeries).toHaveLength(0);

    const missingBaseline = analyzeWallTimeRegression(
      [row({ hour: '2026-07-02T08:00:00Z', p99: 20_000_000, requests: 40 })],
      [],
      { regressionRatio: 2, minRequests: 10 }
    );
    expect(missingBaseline.findings).toHaveLength(0);
    expect(missingBaseline.skipped).toContain(
      'sam-api-staging::project-data-namespace::ProjectData::alarm: no baseline data'
    );
  });

  it('does not false-positive when request volume is below the configured minimum', () => {
    const result = analyzeWallTimeRegression(
      [row({ hour: '2026-07-02T08:00:00Z', p99: 20_000_000, requests: 2 })],
      [row({ hour: '2026-06-25T08:00:00Z', p99: 5_000_000, requests: 2 })],
      { regressionRatio: 2, minRequests: 10 }
    );

    expect(result.findings).toHaveLength(0);
    expect(result.skipped[0]).toContain('requests below minimum');
  });

  it('flags a per-script and namespace invocation-rate explosion normalized by window length', () => {
    const baseline = [
      row({ hour: '2026-06-25T08:00:00Z', p99: 5_000_000, requests: 168 }),
    ];
    const recent = [
      row({ hour: '2026-07-02T08:00:00Z', p99: 5_000_000, requests: 240 }),
    ];

    const result = analyzeInvocationRateRegression(recent, baseline, {
      recentHours: 24,
      baselineHours: 168,
      regressionRatio: 2,
      minRequests: 10,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      key: 'sam-api-staging::project-data-namespace',
      recentRequestsPerHour: 10,
      baselineRequestsPerHour: 1,
      ratio: 10,
    });
  });

  it('aggregates invocation rates across object names and invocation types', () => {
    const summaries = summarizeInvocationRates(
      [
        row({ hour: '2026-07-02T08:00:00Z', p99: 5_000_000, requests: 12 }),
        row({
          hour: '2026-07-02T08:00:00Z',
          name: 'NodeLifecycle',
          type: 'request',
          p99: 3_000_000,
          requests: 36,
        }),
      ],
      24
    );

    expect(summaries).toEqual([
      expect.objectContaining({
        key: 'sam-api-staging::project-data-namespace',
        requestCount: 48,
        requestsPerHour: 2,
      }),
    ]);
  });

  it('retains the minimum-volume filter for invocation-rate findings', () => {
    const result = analyzeInvocationRateRegression(
      [row({ hour: '2026-07-02T08:00:00Z', p99: 5_000_000, requests: 4 })],
      [row({ hour: '2026-06-25T08:00:00Z', p99: 5_000_000, requests: 1 })],
      { recentHours: 24, baselineHours: 168, regressionRatio: 2, minRequests: 10 }
    );

    expect(result.findings).toHaveLength(0);
    expect(result.skipped[0]).toContain('requests below minimum');
  });

  it('treats cron liveness as healthy only when cron.completed has been observed', () => {
    expect(hasCronCompletedEvent({ success: true, result: { data: [{ cnt: 1 }] } })).toBe(true);
    expect(hasCronCompletedEvent({ success: true, result: { data: [{ cnt: 0 }] } })).toBe(false);
    expect(hasCronCompletedEvent({ success: true, result: { data: [] } })).toBe(false);
  });

  it('requires cron liveness to target an explicit API Worker service', () => {
    expect(resolveCronLivenessScriptNames(['sam-api-production'], [])).toEqual([
      'sam-api-production',
    ]);
    expect(resolveCronLivenessScriptNames([], ['sam-api-staging'])).toEqual([
      'sam-api-staging',
    ]);
    expect(() => resolveCronLivenessScriptNames([], [])).toThrow(
      'must target the API Worker'
    );
  });
});
