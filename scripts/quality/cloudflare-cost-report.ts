/** Text report for `pnpm quality:cloudflare-cost`. The analysis itself is shared with the API. */
import {
  CLOUDFLARE_COST_METRIC_KEYS,
  type CloudflareCostAnalysis,
  type CloudflareCostProjectionOptions,
  type CloudflareMetricProjection,
  DEFAULT_CLOUDFLARE_COST_RECENT_DAYS,
} from '../../packages/shared/src/cloudflare-cost/index.js';

export function formatCostReport(
  analysis: CloudflareCostAnalysis,
  options: CloudflareCostProjectionOptions
): string {
  const lines = [
    'Cloudflare cost audit (usage-derived estimate, not invoice reconciliation)',
    `Window: ${options.startDate} through ${options.endDate}; projection uses the most recent ${options.recentDays ?? DEFAULT_CLOUDFLARE_COST_RECENT_DAYS} day(s).`,
    'Durable Object duration uses durableObjectsPeriodicGroups.sum.duration. Invocation wallTime is a latency metric and is not queried for cost.',
    'Workers requests exclude tail-worker invocations (eventType tail); their CPU time is counted.',
    '',
    'Projected monthly usage:',
    'Metric | MTD usage | Projected usage | Allowance | Headroom | Est. cost | Trend',
    '--- | ---: | ---: | ---: | ---: | ---: | ---',
  ];
  for (const projection of analysis.projections) {
    lines.push(
      [
        projection.label,
        formatUsage(projection.monthToDateUsage, projection.unit),
        formatUsage(projection.projectedUsage, projection.unit),
        formatUsage(projection.allowance, projection.unit),
        formatUsage(projection.headroom, projection.unit),
        formatUsd(projection.projectedCostUsd),
        trendLabel(projection.trend),
      ].join(' | ')
    );
  }
  lines.push('', `Projected total: ${formatUsd(analysis.totalProjectedUsd)}`, '', 'Daily series:');
  lines.push(['date', ...CLOUDFLARE_COST_METRIC_KEYS].join(','));
  for (const day of analysis.daily)
    lines.push(
      [day.date, ...CLOUDFLARE_COST_METRIC_KEYS.map((key) => formatNumber(day.metrics[key]))].join(
        ','
      )
    );
  if (analysis.durableObjectNamespaces.length > 0) {
    lines.push('', 'Durable Object namespace duration breakdown:');
    for (const item of analysis.durableObjectNamespaces.slice(0, 20)) {
      lines.push(
        `${item.namespaceId} (${item.sampleObjectName}): ${formatUsage(item.durationGbSeconds, 'GB-s')}, rowsRead=${formatNumber(item.rowsRead)}, rowsWritten=${formatNumber(item.rowsWritten)}`
      );
    }
  }
  if (analysis.durationIdentityViolations.length > 0) {
    lines.push('', 'Duration identity warnings:');
    lines.push(...analysis.durationIdentityViolations.slice(0, 20));
  }
  return lines.join('\n');
}

function trendLabel(trend: CloudflareMetricProjection['trend']): string {
  if (trend === 'early-spike') return 'early spike; recent rate lower';
  if (trend === 'climbing') return 'climbing';
  return 'steady';
}

function formatUsage(value: number, unit: string): string {
  return `${formatNumber(value)} ${unit}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  if (Math.abs(value) >= 10) return value.toFixed(0);
  return value.toFixed(4).replace(/\\.0+$/, '');
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
