/**
 * Cloudflare cost audit.
 *
 * This is a read-only reporting tool. It queries analytics fields that map to
 * billed dimensions and prints usage-derived estimates, not invoice lines.
 */
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_RECENT_DAYS,
  analyzeCloudflareCost,
  createDefaultPricing,
  type CloudflareCostRows,
  formatCostReport,
  type MetricKey,
} from './cloudflare-cost-core';

export const DEFAULT_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
export const DEFAULT_QUERY_LIMIT = 10_000;
export const EXIT_OK = 0;
export const EXIT_BUDGET_EXCEEDED = 1;
export const EXIT_CONFIGURATION_ERROR = 2;

interface Config {
  accountId: string;
  token: string;
  endpoint: string;
  queryLimit: number;
  startDate: string;
  endDate: string;
  recentDays: number;
  maxUsd: number | null;
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        durableObjectsPeriodicGroups?: CloudflareCostRows['durableObjectPeriodic'];
        durableObjectsInvocationsAdaptiveGroups?: CloudflareCostRows['durableObjectInvocations'];
        aiInferenceAdaptiveGroups?: CloudflareCostRows['workersAi'];
        r2StorageAdaptiveGroups?: CloudflareCostRows['r2Storage'];
        d1AnalyticsAdaptiveGroups?: CloudflareCostRows['d1Analytics'];
        d1StorageAdaptiveGroups?: CloudflareCostRows['d1Storage'];
        containersUsageAdaptiveGroups?: CloudflareCostRows['containers'];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const COST_QUERY = `
query CloudflareCostAudit(
  $accountTag: string!
  $doPeriodicFilter: AccountDurableObjectsPeriodicGroupsFilter_InputObject!
  $doInvocationFilter: AccountDurableObjectsInvocationsAdaptiveGroupsFilter_InputObject!
  $aiFilter: AccountAiInferenceAdaptiveGroupsFilter_InputObject!
  $r2StorageFilter: AccountR2StorageAdaptiveGroupsFilter_InputObject!
  $d1AnalyticsFilter: AccountD1AnalyticsAdaptiveGroupsFilter_InputObject!
  $d1StorageFilter: AccountD1StorageAdaptiveGroupsFilter_InputObject!
  $containersFilter: AccountContainersUsageAdaptiveGroupsFilter_InputObject!
  $limit: uint64!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(
        filter: $doPeriodicFilter
        limit: $limit
        orderBy: [date_ASC, namespaceId_ASC, name_ASC]
      ) {
        dimensions { date namespaceId name }
        sum {
          activeTime
          duration
          rowsRead
          rowsWritten
          storageReadUnits
          storageWriteUnits
        }
      }
      durableObjectsInvocationsAdaptiveGroups(
        filter: $doInvocationFilter
        limit: $limit
        orderBy: [date_ASC, scriptName_ASC, namespaceId_ASC, type_ASC]
      ) {
        dimensions { date scriptName namespaceId type }
        sum { requests }
      }
      aiInferenceAdaptiveGroups(
        filter: $aiFilter
        limit: $limit
        orderBy: [date_ASC, modelId_ASC]
      ) {
        dimensions { date modelId }
        sum { totalNeurons }
      }
      r2StorageAdaptiveGroups(
        filter: $r2StorageFilter
        limit: $limit
        orderBy: [date_ASC, bucketName_ASC, storageClass_ASC]
      ) {
        dimensions { date bucketName storageClass }
        max { metadataSize payloadSize }
      }
      d1AnalyticsAdaptiveGroups(
        filter: $d1AnalyticsFilter
        limit: $limit
        orderBy: [date_ASC, databaseId_ASC]
      ) {
        dimensions { date databaseId }
        sum { rowsRead rowsWritten }
      }
      d1StorageAdaptiveGroups(
        filter: $d1StorageFilter
        limit: $limit
        orderBy: [date_ASC, databaseId_ASC]
      ) {
        dimensions { date databaseId }
        max { databaseSizeBytes }
      }
      containersUsageAdaptiveGroups(
        filter: $containersFilter
        limit: $limit
        orderBy: [date_ASC, applicationId_ASC]
      ) {
        dimensions { date applicationId }
        sum { allocatedMemory }
      }
    }
  }
}`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const config = getConfig(argv);
    const rows = await queryCloudflareCostRows(config);
    const analysis = analyzeCloudflareCost(rows, getPricingFromEnv(), {
      startDate: config.startDate,
      endDate: config.endDate,
      recentDays: config.recentDays,
    });
    console.log(
      formatCostReport(analysis, {
        startDate: config.startDate,
        endDate: config.endDate,
        recentDays: config.recentDays,
      })
    );
    if (config.maxUsd !== null && analysis.totalProjectedUsd > config.maxUsd) {
      console.error(
        `Projected usage-derived estimate ${analysis.totalProjectedUsd.toFixed(2)} exceeds --max-usd=${config.maxUsd.toFixed(2)}`
      );
      return EXIT_BUDGET_EXCEEDED;
    }
    return EXIT_OK;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIGURATION_ERROR;
  }
}

export function getConfig(argv: string[], now = new Date()): Config {
  const token = process.env.CF_PRODUCTION_DEBUGGING_TOKEN?.trim();
  const accountId = process.env.CF_PRODUCTION_ACCOUNT_ID?.trim();
  if (!token)
    throw new Error('CF_PRODUCTION_DEBUGGING_TOKEN is required for Cloudflare cost audit');
  if (!accountId) throw new Error('CF_PRODUCTION_ACCOUNT_ID is required for Cloudflare cost audit');
  const args = parseArgs(argv);
  return {
    token,
    accountId,
    endpoint: process.env.CF_COST_GRAPHQL_ENDPOINT?.trim() || DEFAULT_GRAPHQL_ENDPOINT,
    queryLimit: readPositiveNumber('CF_COST_QUERY_LIMIT', DEFAULT_QUERY_LIMIT),
    startDate: args.startDate ?? firstDayOfUtcMonth(now),
    endDate: args.endDate ?? lastCompleteUtcDate(now),
    recentDays: args.recentDays ?? readPositiveNumber('CF_COST_RECENT_DAYS', DEFAULT_RECENT_DAYS),
    maxUsd: args.maxUsd,
  };
}

export function getPricingFromEnv() {
  const pricing = createDefaultPricing();
  for (const key of Object.keys(pricing.metrics) as MetricKey[]) {
    const envPrefix = `CF_COST_${toEnvKey(key)}`;
    const metric = pricing.metrics[key];
    pricing.metrics[key] = {
      ...metric,
      allowance: readPositiveNumber(`${envPrefix}_ALLOWANCE`, metric.allowance),
      rateUsd: readPositiveNumber(`${envPrefix}_RATE_USD`, metric.rateUsd),
      rateUnit: readPositiveNumber(`${envPrefix}_RATE_UNIT`, metric.rateUnit),
    };
  }
  return pricing;
}

export async function queryCloudflareCostRows(config: Config): Promise<CloudflareCostRows> {
  const dateFilter = {
    date_geq: config.startDate,
    date_leq: config.endDate,
  };
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: COST_QUERY,
      variables: {
        accountTag: config.accountId,
        doPeriodicFilter: dateFilter,
        doInvocationFilter: dateFilter,
        aiFilter: dateFilter,
        r2StorageFilter: dateFilter,
        d1AnalyticsFilter: dateFilter,
        d1StorageFilter: dateFilter,
        containersFilter: dateFilter,
        limit: config.queryLimit,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare GraphQL request failed: ${response.status} ${response.statusText}`);
  }
  return parseCostResponse(await response.json(), config.queryLimit);
}

export function parseCostResponse(payload: unknown, queryLimit: number): CloudflareCostRows {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Cloudflare GraphQL response must be an object');
  }
  const response = payload as GraphQLResponse;
  if (response.errors?.length) {
    throw new Error(
      `Cloudflare GraphQL error: ${response.errors.map((error) => error.message).join('; ')}`
    );
  }
  const account = response.data?.viewer?.accounts?.[0];
  if (!account)
    throw new Error('Cloudflare GraphQL response did not include the requested account');
  const rows: CloudflareCostRows = {
    durableObjectPeriodic: account.durableObjectsPeriodicGroups ?? [],
    durableObjectInvocations: account.durableObjectsInvocationsAdaptiveGroups ?? [],
    workersAi: account.aiInferenceAdaptiveGroups ?? [],
    r2Storage: account.r2StorageAdaptiveGroups ?? [],
    d1Analytics: account.d1AnalyticsAdaptiveGroups ?? [],
    d1Storage: account.d1StorageAdaptiveGroups ?? [],
    containers: account.containersUsageAdaptiveGroups ?? [],
  };
  for (const [name, dataset] of Object.entries(rows)) {
    if (dataset.length >= queryLimit) {
      throw new Error(
        `${name} returned ${dataset.length} rows, which reached CF_COST_QUERY_LIMIT=${queryLimit}; refusing a partial cost report`
      );
    }
  }
  return rows;
}

function parseArgs(argv: string[]): {
  startDate?: string;
  endDate?: string;
  recentDays?: number;
  maxUsd: number | null;
} {
  const parsed: ReturnType<typeof parseArgs> = { maxUsd: null };
  for (const arg of argv) {
    if (arg.startsWith('--max-usd=')) parsed.maxUsd = parseCliNumber(arg, '--max-usd=');
    else if (arg.startsWith('--start-date=')) parsed.startDate = parseCliDate(arg, '--start-date=');
    else if (arg.startsWith('--end-date=')) parsed.endDate = parseCliDate(arg, '--end-date=');
    else if (arg.startsWith('--recent-days='))
      parsed.recentDays = parseCliNumber(arg, '--recent-days=');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function parseCliNumber(arg: string, prefix: string): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${prefix.slice(0, -1)} must be a non-negative number`);
  return value;
}

function parseCliDate(arg: string, prefix: string): string {
  const value = arg.slice(prefix.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${prefix.slice(0, -1)} must use YYYY-MM-DD`);
  return value;
}

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function firstDayOfUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function lastCompleteUtcDate(now: Date): string {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const previousDay = new Date(todayStart - 24 * 60 * 60 * 1000);
  if (previousDay.getUTCMonth() !== now.getUTCMonth()) return now.toISOString().slice(0, 10);
  return previousDay.toISOString().slice(0, 10);
}

function toEnvKey(key: MetricKey): string {
  return key.replace(/[A-Z]/g, (match) => `_${match}`).toUpperCase();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
