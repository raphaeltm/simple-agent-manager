/** Optional read-only companion to check-cloudflare-cost: attributed rows, not invoice totals. */
import { pathToFileURL } from 'node:url';

import * as v from 'valibot';

import { ROW_USAGE_LABEL_LIMIT } from '../../packages/project-data/src/do/row-usage-config';

const metricNames = ['calls', 'rowsRead', 'rowsWritten', 'alarmWrites'] as const;
const resultSchema = v.object({
  success: v.literal(true),
  result: v.object({
    calculations: v.array(
      v.object({
        alias: v.string(),
        aggregates: v.array(
          v.object({
            value: v.number(),
            groups: v.optional(
              v.array(
                v.object({ key: v.string(), value: v.union([v.string(), v.number(), v.boolean()]) })
              )
            ),
          })
        ),
      })
    ),
  }),
});
export interface LabelRows {
  label: string;
  calls: number;
  rowsRead: number;
  rowsWritten: number;
  alarmWrites: number;
}
export function completeUtcDay(now = new Date()): { from: number; to: number } {
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: to - 86_400_000, to };
}
export function rowUsageQuery(
  rank: number,
  timeframe: { from: number; to: number },
  service: string,
  projectId?: string
) {
  const prefix = `labels.rank${rank}`;
  return {
    queryId: `sam-project-data-row-usage-${rank}`,
    timeframe,
    dry: true,
    chart: false,
    ignoreSeries: true,
    view: 'calculations',
    parameters: {
      calculations: metricNames.map((key) => ({
        operator: 'sum',
        key: `${prefix}.${key}`,
        alias: key,
        keyType: 'number',
      })),
      groupBys: [{ type: 'string', value: `${prefix}.label` }],
      filters: [
        { key: '$metadata.service', operation: 'eq', type: 'string', value: service },
        { key: 'event', operation: 'eq', type: 'string', value: 'project_data.row_usage' },
        ...(projectId
          ? [{ key: 'projectId', operation: 'eq', type: 'string', value: projectId }]
          : []),
      ],
      filterCombination: 'and',
      limit: 1000,
    },
  };
}
export function parseRowUsage(payload: unknown, rank: number): LabelRows[] {
  const parsed = v.parse(resultSchema, payload);
  const rows = new Map<string, LabelRows>();
  const seen = new Map<string, Set<string>>();
  for (const calculation of parsed.result.calculations) {
    if (!(metricNames as readonly string[]).includes(calculation.alias))
      throw new Error('Unexpected calculation');
    if (calculation.aggregates.length >= 1000)
      throw new Error('Telemetry label results reached the query limit');
    for (const aggregate of calculation.aggregates) {
      const label = aggregate.groups?.find(
        (group) => group.key === `labels.rank${rank}.label`
      )?.value;
      if (
        typeof label !== 'string' ||
        label === '' ||
        !Number.isFinite(aggregate.value) ||
        aggregate.value < 0
      )
        throw new Error('Invalid row usage aggregate');
      const row = rows.get(label) ?? {
        label,
        calls: 0,
        rowsRead: 0,
        rowsWritten: 0,
        alarmWrites: 0,
      };
      const metric = calculation.alias as (typeof metricNames)[number];
      const metrics = seen.get(label) ?? new Set<string>();
      if (metrics.has(metric)) throw new Error('Duplicate label aggregate');
      metrics.add(metric);
      seen.set(label, metrics);
      row[metric] += aggregate.value;
      rows.set(label, row);
    }
  }
  if ([...seen.values()].some((metrics) => metrics.size !== metricNames.length))
    throw new Error('Incomplete label metrics');
  return [...rows.values()];
}
export async function reportProjectDataRows(options: {
  token: string;
  accountId: string;
  service: string;
  projectId?: string;
  timeframe?: { from: number; to: number };
  fetcher?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}): Promise<string> {
  try {
    if (!options.token || !options.accountId || !options.service)
      throw new Error('Missing credentials or Worker service');
    const totals = new Map<string, LabelRows>();
    const timeframe = options.timeframe ?? completeUtcDay();
    // Each log contains ranked slots. Group each slot by its label and merge across ranks;
    // otherwise a method moving rank between windows would be attributed to the wrong writer.
    const rankedRows = await Promise.all(
      Array.from({ length: ROW_USAGE_LABEL_LIMIT + 1 }, async (_, rank) => {
        const response = await (options.fetcher ?? fetch)(
          options.endpoint ??
            `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/workers/observability/telemetry/query`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${options.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(
              rowUsageQuery(rank, timeframe, options.service, options.projectId)
            ),
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          }
        );
        if (!response.ok) throw new Error(`Workers telemetry HTTP ${response.status}`);
        return parseRowUsage(await response.json(), rank);
      })
    );
    for (const rows of rankedRows) {
      for (const row of rows) {
        const total = totals.get(row.label) ?? {
          label: row.label,
          calls: 0,
          rowsRead: 0,
          rowsWritten: 0,
          alarmWrites: 0,
        };
        for (const metric of metricNames) total[metric] += row[metric];
        totals.set(row.label, total);
      }
    }
    if (!totals.size)
      return 'ProjectData row writers: not available (no row_usage events in the last complete UTC day).';
    const rows = [...totals.values()].sort(
      (a, b) => b.rowsWritten - a.rowsWritten || a.label.localeCompare(b.label)
    );
    return [
      `ProjectData row writers (${new Date(timeframe.from).toISOString()} to ${new Date(timeframe.to).toISOString()}; logged attribution, subject to eviction/sampling):`,
      'label | rowsWritten | rowsRead | alarmWrites | calls',
      ...rows.map(
        (row) =>
          `${row.label} | ${row.rowsWritten} | ${row.rowsRead} | ${row.alarmWrites} | ${row.calls}`
      ),
      'other includes unattributed work and labels below the per-window cap; see droppedLabelCount on row_usage logs.',
    ].join('\n');
  } catch (error) {
    // Never substitute zeros for failed or malformed telemetry. Do not print raw response bodies.
    return `ProjectData row writers: not available (${error instanceof Error && error.message.startsWith('Workers telemetry HTTP') ? error.message : 'query failed, missing configuration, or invalid telemetry response'}).`;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(
    await reportProjectDataRows({
      token: process.env.CF_PRODUCTION_DEBUGGING_TOKEN ?? '',
      accountId: process.env.CF_PRODUCTION_ACCOUNT_ID ?? '',
      service: process.env.CF_ROW_USAGE_SERVICE ?? '',
      projectId: process.env.CF_ROW_USAGE_PROJECT_ID,
      endpoint: process.env.CF_ROW_USAGE_ENDPOINT,
    })
  );
}
