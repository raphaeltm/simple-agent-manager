/**
 * Coverage Threshold Baseline Report
 *
 * Reports package coverage threshold drift against the last measured baseline.
 * This is intentionally report-only: it makes low/drifting thresholds visible
 * without destabilizing CI or ratcheting thresholds prematurely.
 *
 * Usage:
 *   pnpm tsx scripts/quality/check-coverage-threshold-baseline.ts [--json]
 */

type CoverageThresholds = {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
};

type CoverageBaseline = {
  packageName: string;
  configPath: string;
  measuredOn: string;
  measured: CoverageThresholds;
  thresholds: CoverageThresholds;
  note: string;
};

const MINIMUM_HEADROOM_PERCENT = 3;

const BASELINES: CoverageBaseline[] = [
  {
    packageName: 'apps/api',
    configPath: 'apps/api/vitest.config.ts',
    measuredOn: '2026-05-07',
    measured: { statements: 48.72, branches: 44.01, functions: 47.24, lines: 49.07 },
    thresholds: { statements: 45, branches: 40, functions: 44, lines: 45 },
    note: 'Historical baseline from tasks/archive/2026-05-07-coverage-thresholds-playwright-ci.md.',
  },
  {
    packageName: 'apps/web',
    configPath: 'apps/web/vitest.config.ts',
    measuredOn: '2026-05-07',
    measured: { statements: 56.14, branches: 52.31, functions: 49.28, lines: 57.89 },
    thresholds: { statements: 53, branches: 49, functions: 46, lines: 55 },
    note: 'Historical baseline from tasks/archive/2026-05-07-coverage-thresholds-playwright-ci.md.',
  },
  {
    packageName: 'packages/shared',
    configPath: 'packages/shared/vitest.config.ts',
    measuredOn: '2026-05-07',
    measured: { statements: 86.94, branches: 34.69, functions: 63.15, lines: 86.71 },
    thresholds: { statements: 83, branches: 30, functions: 60, lines: 83 },
    note: 'Historical baseline from tasks/archive/2026-05-07-coverage-thresholds-playwright-ci.md.',
  },
  {
    packageName: 'packages/providers',
    configPath: 'packages/providers/vitest.config.ts',
    measuredOn: '2026-05-07',
    measured: { statements: 74.59, branches: 75.36, functions: 81.96, lines: 75.86 },
    thresholds: { statements: 71, branches: 72, functions: 78, lines: 72 },
    note: 'Historical baseline from tasks/archive/2026-05-07-coverage-thresholds-playwright-ci.md.',
  },
];

function headroom(measured: number, threshold: number): number {
  return Number((measured - threshold).toFixed(2));
}

function summarizeBaseline(baseline: CoverageBaseline) {
  const metrics = Object.entries(baseline.thresholds).map(([metric, threshold]) => {
    const measured = baseline.measured[metric as keyof CoverageThresholds];
    const margin = headroom(measured, threshold);
    return {
      metric,
      measured,
      threshold,
      headroom: margin,
      lowHeadroom: margin < MINIMUM_HEADROOM_PERCENT,
    };
  });

  return {
    ...baseline,
    metrics,
    lowHeadroomMetrics: metrics
      .filter((metric) => metric.lowHeadroom)
      .map((metric) => metric.metric),
  };
}

function main(): void {
  const json = process.argv.includes('--json');
  const report = BASELINES.map(summarizeBaseline);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('Coverage threshold baseline report (non-failing).');
  console.log(
    `Low-headroom marker: measured baseline is less than ${MINIMUM_HEADROOM_PERCENT}% above threshold.`
  );

  for (const item of report) {
    const lowHeadroom =
      item.lowHeadroomMetrics.length > 0 ? item.lowHeadroomMetrics.join(', ') : 'none';
    console.log(`\n${item.packageName} (${item.configPath}, measured ${item.measuredOn})`);
    console.log(`  low-headroom metrics: ${lowHeadroom}`);
    for (const metric of item.metrics) {
      console.log(
        `  ${metric.metric}: measured ${metric.measured}% / threshold ${metric.threshold}% / headroom ${metric.headroom}%`
      );
    }
  }
}

main();
