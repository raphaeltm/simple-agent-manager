import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { resolveAdminSetting } from '../services/admin-settings-resolution';
import { fetchWithTimeout } from '../services/fetch-timeout';

export const DEFAULT_ANALYTICS_SQL_API_URL = 'https://api.cloudflare.com/client/v4/accounts';

export const DEFAULT_PERIOD_DAYS = 30;

export const DEFAULT_TOP_EVENTS_LIMIT = 50;

export const DEFAULT_GEO_LIMIT = 50;

export const DEFAULT_RETENTION_WEEKS = 12;

export const DEFAULT_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT = 20;

/** Analytics Engine hard cap on result rows; queries without explicit LIMIT silently truncate here. */
export const MAX_RETENTION_QUERY_ROWS = 10_000;

export const analyticsSqlResponseSchema = v.object({
  data: v.optional(v.array(v.unknown())),
  meta: v.optional(v.array(v.unknown())),
});

/** Parse an integer env var with validation; returns fallback on NaN or non-positive values. */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const VALID_PERIODS = ['24h', '7d', '30d', '90d'] as const;

export type Period = (typeof VALID_PERIODS)[number];

/** Validate and normalize a period query param. Returns a safe Period value. */
export function parsePeriod(raw: string | undefined): Period {
  return (VALID_PERIODS as readonly string[]).includes(raw ?? '') ? (raw as Period) : '7d';
}

/** Convert a validated period to an Analytics Engine SQL interval expression. */
export function periodToInterval(period: Period): string {
  switch (period) {
    case '24h':
      return "INTERVAL '1' DAY";
    case '30d':
      return "INTERVAL '30' DAY";
    case '90d':
      return "INTERVAL '90' DAY";
    case '7d':
    default:
      return "INTERVAL '7' DAY";
  }
}

/** Feature event categories for grouping in the adoption chart. */
export const FEATURE_EVENTS = [
  'project_created',
  'project_deleted',
  'workspace_created',
  'workspace_started',
  'workspace_stopped',
  'task_submitted',
  'task_completed',
  'task_failed',
  'node_created',
  'node_deleted',
  'credential_saved',
  'session_created',
  'settings_changed',
];

/**
 * Execute an Analytics Engine SQL query via the Cloudflare API.
 */
export async function queryAnalyticsEngine(env: Env, sql: string): Promise<unknown> {
  const baseUrl = env.ANALYTICS_SQL_API_URL || DEFAULT_ANALYTICS_SQL_API_URL;
  const accountId = env.CF_ACCOUNT_ID;

  if (!accountId) {
    throw errors.internal('CF_ACCOUNT_ID is not configured');
  }

  const url = `${baseUrl}/${accountId}/analytics_engine/sql`;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    },
    Number(await resolveAdminSetting(env, 'performance.externalReadTimeoutMs'))
  );

  if (!response.ok) {
    const body = await response.text();
    log.error('analytics.sql_api_error', {
      status: response.status,
      body: body.slice(0, 500),
      sql: sql.slice(0, 300),
    });
    throw errors.internal(`Analytics Engine query failed: ${response.status}`);
  }

  const body = await readResponseJson(response, analyticsSqlResponseSchema, 'analytics.sql');
  // Return only the data rows — do not leak internal column metadata to the client
  return body.data ?? [];
}
