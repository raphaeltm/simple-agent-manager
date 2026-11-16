/**
 * Cloudflare cost audit.
 *
 * This is a read-only reporting tool. It queries analytics fields that map to
 * billed dimensions and prints usage-derived estimates, not invoice lines.
 */
import { pathToFileURL } from 'node:url';

import {
  analyzeCloudflareCost,
  CLOUDFLARE_GRAPHQL_ENDPOINT,
  cloudflareCostHttpError,
  type CloudflareCostMetricKey,
  cloudflareCostQueryBody,
  type CloudflareCostRows,
  createCloudflarePricing,
  DEFAULT_CLOUDFLARE_COST_RECENT_DAYS,
  parseCloudflareCostResponse,
} from '../../packages/shared/src/cloudflare-cost/index.js';
import { formatCostReport } from './cloudflare-cost-report';

export const DEFAULT_GRAPHQL_ENDPOINT = CLOUDFLARE_GRAPHQL_ENDPOINT;
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
    recentDays:
      args.recentDays ??
      readPositiveNumber('CF_COST_RECENT_DAYS', DEFAULT_CLOUDFLARE_COST_RECENT_DAYS),
    maxUsd: args.maxUsd,
  };
}

export function getPricingFromEnv() {
  const pricing = createCloudflarePricing();
  for (const key of Object.keys(pricing.metrics) as CloudflareCostMetricKey[]) {
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
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: cloudflareCostQueryBody({
      accountId: config.accountId,
      startDate: config.startDate,
      endDate: config.endDate,
      limit: config.queryLimit,
      options: { durableObjectBreakdown: true },
    }),
  });
  if (!response.ok)
    throw cloudflareCostHttpError(response.status, await response.json().catch(() => null));
  return parseCloudflareCostResponse(await response.json(), config.queryLimit);
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

function toEnvKey(key: CloudflareCostMetricKey): string {
  return key.replace(/[A-Z]/g, (match) => `_${match}`).toUpperCase();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
