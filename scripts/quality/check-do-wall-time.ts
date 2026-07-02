/**
 * Durable Object Wall-Time Regression Check
 *
 * Queries Cloudflare GraphQL Analytics for Durable Object invocation P99 wall
 * time, compares a recent window against a prior baseline window, and fails
 * when a per-script/namespace/object series regresses beyond the configured
 * threshold.
 *
 * Configuration:
 *   CF_TOKEN                         Cloudflare API token (required)
 *   CF_ACCOUNT_ID                    Cloudflare account ID (required)
 *   DO_WALL_TIME_RECENT_HOURS        Recent window length (default: 24)
 *   DO_WALL_TIME_BASELINE_HOURS      Baseline window before recent (default: 168)
 *   DO_WALL_TIME_REGRESSION_RATIO    Failure ratio (default: 2)
 *   DO_WALL_TIME_MIN_REQUESTS        Minimum recent+baseline requests (default: 10)
 *   DO_WALL_TIME_LIMIT               GraphQL row limit per query (default: 10000)
 *   DO_WALL_TIME_SCRIPT_NAMES        Optional comma-separated scriptName filter
 *   DO_WALL_TIME_NAMESPACE_IDS       Optional comma-separated namespaceId filter
 *   DO_WALL_TIME_OBJECT_NAMES        Optional comma-separated Durable Object name filter
 *   DO_WALL_TIME_INVOCATION_TYPES    Optional comma-separated type filter (default: alarm; use all to disable)
 *   DO_WALL_TIME_GRAPHQL_ENDPOINT    Optional GraphQL endpoint override
 *
 * Exit codes:
 *   0 — No regression detected, or insufficient data
 *   1 — Wall-time regression detected
 *   2 — Configuration/API error
 */
import { pathToFileURL } from 'node:url';

export const DEFAULT_RECENT_WINDOW_HOURS = 24;
export const DEFAULT_BASELINE_WINDOW_HOURS = 168;
export const DEFAULT_REGRESSION_RATIO = 2;
export const DEFAULT_MIN_REQUESTS = 10;
export const DEFAULT_QUERY_LIMIT = 10_000;
export const DEFAULT_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
export const DEFAULT_INVOCATION_TYPES = ['alarm'];
const WALL_TIME_MICROSECONDS_PER_MILLISECOND = 1_000;

interface Config {
  cfToken: string;
  cfAccountId: string;
  recentHours: number;
  baselineHours: number;
  regressionRatio: number;
  minRequests: number;
  queryLimit: number;
  scriptNames: string[];
  namespaceIds: string[];
  objectNames: string[];
  invocationTypes: string[];
  graphqlEndpoint: string;
  now: Date;
}

export interface DurableObjectWallTimeRow {
  dimensions: {
    datetimeHour?: string;
    scriptName?: string;
    namespaceId?: string;
    name?: string;
    type?: string;
  };
  quantiles?: {
    wallTimeP99?: number | null;
    wallTimeP999?: number | null;
  };
  sum?: {
    requests?: number | null;
  };
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        durableObjectsInvocationsAdaptiveGroups?: DurableObjectWallTimeRow[];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export interface SeriesSummary {
  key: string;
  scriptName: string;
  namespaceId: string;
  objectName: string;
  invocationType: string;
  bucketCount: number;
  requestCount: number;
  averageP99Ms: number;
  maxP99Ms: number;
  maxP999Ms: number;
}

export interface WallTimeFinding {
  key: string;
  scriptName: string;
  namespaceId: string;
  objectName: string;
  invocationType: string;
  recentAverageP99Ms: number;
  baselineAverageP99Ms: number;
  recentMaxP99Ms: number;
  baselineMaxP99Ms: number;
  recentRequests: number;
  baselineRequests: number;
  ratio: number;
}

export interface AnalysisResult {
  findings: WallTimeFinding[];
  skipped: string[];
  recentSeries: SeriesSummary[];
  baselineSeries: SeriesSummary[];
}

interface WindowRange {
  start: Date;
  end: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseInvocationTypesEnv(): string[] {
  const configured = parseCsvEnv('DO_WALL_TIME_INVOCATION_TYPES');
  if (configured.length === 0) return DEFAULT_INVOCATION_TYPES;
  if (configured.some((item) => item.toLowerCase() === 'all')) return [];
  return configured;
}

export function getConfig(now = new Date()): Config {
  const cfToken = process.env.CF_TOKEN;
  const cfAccountId = process.env.CF_ACCOUNT_ID;
  if (!cfToken) throw new Error('CF_TOKEN environment variable is required');
  if (!cfAccountId) throw new Error('CF_ACCOUNT_ID environment variable is required');

  return {
    cfToken,
    cfAccountId,
    recentHours: parseNumberEnv('DO_WALL_TIME_RECENT_HOURS', DEFAULT_RECENT_WINDOW_HOURS),
    baselineHours: parseNumberEnv('DO_WALL_TIME_BASELINE_HOURS', DEFAULT_BASELINE_WINDOW_HOURS),
    regressionRatio: parseNumberEnv('DO_WALL_TIME_REGRESSION_RATIO', DEFAULT_REGRESSION_RATIO),
    minRequests: parseNumberEnv('DO_WALL_TIME_MIN_REQUESTS', DEFAULT_MIN_REQUESTS),
    queryLimit: parseNumberEnv('DO_WALL_TIME_LIMIT', DEFAULT_QUERY_LIMIT),
    scriptNames: parseCsvEnv('DO_WALL_TIME_SCRIPT_NAMES'),
    namespaceIds: parseCsvEnv('DO_WALL_TIME_NAMESPACE_IDS'),
    objectNames: parseCsvEnv('DO_WALL_TIME_OBJECT_NAMES'),
    invocationTypes: parseInvocationTypesEnv(),
    graphqlEndpoint: process.env.DO_WALL_TIME_GRAPHQL_ENDPOINT ?? DEFAULT_GRAPHQL_ENDPOINT,
    now,
  };
}

export function getWindows(
  now: Date,
  recentHours: number,
  baselineHours: number
): {
  recent: WindowRange;
  baseline: WindowRange;
} {
  const recentEnd = now;
  const recentStart = new Date(recentEnd.getTime() - recentHours * 60 * 60 * 1000);
  const baselineEnd = recentStart;
  const baselineStart = new Date(baselineEnd.getTime() - baselineHours * 60 * 60 * 1000);
  return {
    recent: { start: recentStart, end: recentEnd },
    baseline: { start: baselineStart, end: baselineEnd },
  };
}

function buildFilter(config: Config, range: WindowRange): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    datetime_geq: range.start.toISOString(),
    datetime_lt: range.end.toISOString(),
  };
  if (config.scriptNames.length === 1) filter.scriptName = config.scriptNames[0];
  if (config.scriptNames.length > 1) filter.scriptName_in = config.scriptNames;
  if (config.namespaceIds.length === 1) filter.namespaceId = config.namespaceIds[0];
  if (config.namespaceIds.length > 1) filter.namespaceId_in = config.namespaceIds;
  if (config.objectNames.length === 1) filter.name = config.objectNames[0];
  if (config.objectNames.length > 1) filter.name_in = config.objectNames;
  if (config.invocationTypes.length === 1) filter.type = config.invocationTypes[0];
  if (config.invocationTypes.length > 1) filter.type_in = config.invocationTypes;
  return filter;
}

const DURABLE_OBJECT_WALL_TIME_QUERY = `
query DurableObjectWallTime(
  $accountTag: string!
  $filter: AccountDurableObjectsInvocationsAdaptiveGroupsFilter_InputObject!
  $limit: uint64!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(
        filter: $filter
        limit: $limit
        orderBy: [datetimeHour_ASC, scriptName_ASC, namespaceId_ASC, name_ASC, type_ASC]
      ) {
        dimensions {
          datetimeHour
          scriptName
          namespaceId
          name
          type
        }
        quantiles {
          wallTimeP99
          wallTimeP999
        }
        sum {
          requests
        }
      }
    }
  }
}`;

function parseGraphQLResponse(payload: unknown): DurableObjectWallTimeRow[] {
  if (!isRecord(payload)) throw new Error('GraphQL response must be an object');
  const response = payload as GraphQLResponse;
  if (response.errors?.length) {
    throw new Error(
      `Cloudflare GraphQL error: ${response.errors.map((error) => error.message).join('; ')}`
    );
  }
  const accounts = response.data?.viewer?.accounts;
  if (!accounts?.length) return [];
  return accounts.flatMap((account) => account.durableObjectsInvocationsAdaptiveGroups ?? []);
}

async function queryWallTimeRows(
  config: Config,
  range: WindowRange
): Promise<DurableObjectWallTimeRow[]> {
  const resp = await fetch(config.graphqlEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.cfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: DURABLE_OBJECT_WALL_TIME_QUERY,
      variables: {
        accountTag: config.cfAccountId,
        filter: buildFilter(config, range),
        limit: config.queryLimit,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Cloudflare GraphQL request failed: ${resp.status} ${resp.statusText}`);
  }

  return parseGraphQLResponse(await resp.json());
}

function seriesKey(row: DurableObjectWallTimeRow): string {
  const scriptName = row.dimensions.scriptName ?? 'unknown-script';
  const namespaceId = row.dimensions.namespaceId ?? 'unknown-namespace';
  const objectName = row.dimensions.name ?? 'all-objects';
  const invocationType = row.dimensions.type ?? 'unknown-type';
  return `${scriptName}::${namespaceId}::${objectName}::${invocationType}`;
}

function rawWallTimeToMs(rawValue: number): number {
  return rawValue / WALL_TIME_MICROSECONDS_PER_MILLISECOND;
}

export function summarizeRows(rows: DurableObjectWallTimeRow[]): SeriesSummary[] {
  const groups = new Map<string, DurableObjectWallTimeRow[]>();
  for (const row of rows) {
    const p99 = row.quantiles?.wallTimeP99;
    if (typeof p99 !== 'number' || !Number.isFinite(p99)) continue;
    const key = seriesKey(row);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  return Array.from(groups.entries())
    .map(([key, groupRows]) => {
      const first = groupRows[0];
      const p99Values = groupRows.map((row) => rawWallTimeToMs(row.quantiles?.wallTimeP99 ?? 0));
      const p999Values = groupRows.map((row) => rawWallTimeToMs(row.quantiles?.wallTimeP999 ?? 0));
      const requestCount = groupRows.reduce((sum, row) => sum + Number(row.sum?.requests ?? 0), 0);
      return {
        key,
        scriptName: first?.dimensions.scriptName ?? 'unknown-script',
        namespaceId: first?.dimensions.namespaceId ?? 'unknown-namespace',
        objectName: first?.dimensions.name ?? 'all-objects',
        invocationType: first?.dimensions.type ?? 'unknown-type',
        bucketCount: groupRows.length,
        requestCount,
        averageP99Ms: p99Values.reduce((sum, value) => sum + value, 0) / p99Values.length,
        maxP99Ms: Math.max(...p99Values),
        maxP999Ms: Math.max(...p999Values),
      };
    })
    .sort((a, b) => b.averageP99Ms - a.averageP99Ms);
}

export function analyzeWallTimeRegression(
  recentRows: DurableObjectWallTimeRow[],
  baselineRows: DurableObjectWallTimeRow[],
  options: { regressionRatio: number; minRequests: number }
): AnalysisResult {
  const recentSeries = summarizeRows(recentRows);
  const baselineSeries = summarizeRows(baselineRows);
  const baselineByKey = new Map(baselineSeries.map((summary) => [summary.key, summary]));
  const findings: WallTimeFinding[] = [];
  const skipped: string[] = [];

  for (const recent of recentSeries) {
    const baseline = baselineByKey.get(recent.key);
    if (!baseline) {
      skipped.push(`${recent.key}: no baseline data`);
      continue;
    }
    const totalRequests = recent.requestCount + baseline.requestCount;
    if (totalRequests < options.minRequests) {
      skipped.push(`${recent.key}: ${totalRequests} requests below minimum ${options.minRequests}`);
      continue;
    }
    if (baseline.averageP99Ms <= 0) {
      skipped.push(`${recent.key}: baseline P99 is zero or missing`);
      continue;
    }

    const ratio = recent.averageP99Ms / baseline.averageP99Ms;
    if (ratio >= options.regressionRatio) {
      findings.push({
        key: recent.key,
        scriptName: recent.scriptName,
        namespaceId: recent.namespaceId,
        objectName: recent.objectName,
        invocationType: recent.invocationType,
        recentAverageP99Ms: recent.averageP99Ms,
        baselineAverageP99Ms: baseline.averageP99Ms,
        recentMaxP99Ms: recent.maxP99Ms,
        baselineMaxP99Ms: baseline.maxP99Ms,
        recentRequests: recent.requestCount,
        baselineRequests: baseline.requestCount,
        ratio,
      });
    }
  }

  findings.sort((a, b) => b.ratio - a.ratio);
  return { findings, skipped, recentSeries, baselineSeries };
}

function formatMs(value: number): string {
  return `${Math.round(value).toLocaleString('en-US')}ms`;
}

export function formatReport(result: AnalysisResult, threshold: number): string {
  const lines: string[] = [];
  lines.push(`Recent series: ${result.recentSeries.length}`);
  lines.push(`Baseline series: ${result.baselineSeries.length}`);
  if (result.skipped.length > 0) {
    lines.push(`Skipped series: ${result.skipped.length}`);
  }

  if (result.findings.length === 0) {
    lines.push(`No Durable Object wall-time regressions detected at ${threshold}x threshold.`);
    return lines.join('\n');
  }

  lines.push(`Durable Object wall-time regressions detected: ${result.findings.length}`);
  for (const finding of result.findings) {
    lines.push('');
    lines.push(
      `- ${finding.scriptName} / ${finding.namespaceId} / ${finding.objectName} / ${finding.invocationType}`
    );
    lines.push(`  ratio: ${finding.ratio.toFixed(2)}x`);
    lines.push(
      `  recent avg P99: ${formatMs(finding.recentAverageP99Ms)} ` +
        `(max ${formatMs(finding.recentMaxP99Ms)}, requests ${finding.recentRequests})`
    );
    lines.push(
      `  baseline avg P99: ${formatMs(finding.baselineAverageP99Ms)} ` +
        `(max ${formatMs(finding.baselineMaxP99Ms)}, requests ${finding.baselineRequests})`
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log('Durable Object Wall-Time Regression Check');
  console.log('='.repeat(52));

  const config = getConfig();
  const windows = getWindows(config.now, config.recentHours, config.baselineHours);
  console.log(
    `Recent window: ${windows.recent.start.toISOString()} to ${windows.recent.end.toISOString()}`
  );
  console.log(
    `Baseline window: ${windows.baseline.start.toISOString()} to ${windows.baseline.end.toISOString()}`
  );
  console.log(
    `Threshold: ${config.regressionRatio}x | Minimum requests: ${config.minRequests} | Limit: ${config.queryLimit}`
  );
  if (config.scriptNames.length > 0) console.log(`Script filter: ${config.scriptNames.join(', ')}`);
  if (config.namespaceIds.length > 0)
    console.log(`Namespace filter: ${config.namespaceIds.join(', ')}`);
  if (config.objectNames.length > 0)
    console.log(`Object-name filter: ${config.objectNames.join(', ')}`);
  if (config.invocationTypes.length > 0) {
    console.log(`Invocation type filter: ${config.invocationTypes.join(', ')}`);
  } else {
    console.log('Invocation type filter: all');
  }
  console.log('');

  const [recentRows, baselineRows] = await Promise.all([
    queryWallTimeRows(config, windows.recent),
    queryWallTimeRows(config, windows.baseline),
  ]);

  const result = analyzeWallTimeRegression(recentRows, baselineRows, {
    regressionRatio: config.regressionRatio,
    minRequests: config.minRequests,
  });
  console.log(formatReport(result, config.regressionRatio));

  if (result.findings.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
