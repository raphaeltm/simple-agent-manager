import type { Env } from '../env';
import { expectJsonRecord, optionalJsonRecord } from '../lib/runtime-validation';
import { fetchWithTimeout } from './fetch-timeout';
import { CfApiError, redactSensitiveData } from './observability-cf-support';
import {
  CF_OBSERVABILITY_API_BASE,
  DEFAULT_LOG_QUERY_LIMIT,
  DEFAULT_LOG_QUERY_RATE_LIMIT,
  getConfigNumber,
  MAX_LOG_QUERY_LIMIT,
  type QueryCloudflarLogsInput,
} from './observability-common';

/**
 * Get the configured rate limit for CF log queries (per minute).
 */
export function getLogQueryRateLimit(env: Env): number {
  return getConfigNumber(env, 'OBSERVABILITY_LOG_QUERY_RATE_LIMIT', DEFAULT_LOG_QUERY_RATE_LIMIT);
}

/**
 * Proxy query to Cloudflare Workers Observability Telemetry API.
 * Transforms request/response and never exposes CF credentials or raw errors.
 */
export async function queryCloudflareLogs(input: QueryCloudflarLogsInput): Promise<{
  logs: Array<{
    timestamp: string;
    level: string;
    event: string;
    message: string;
    details: Record<string, unknown>;
    invocationId?: string;
  }>;
  cursor: string | null;
  hasMore: boolean;
  queryId: string;
}> {
  const limit = Math.min(input.limit ?? DEFAULT_LOG_QUERY_LIMIT, MAX_LOG_QUERY_LIMIT);
  const queryId = input.queryId || crypto.randomUUID();

  // Build the CF Observability API query
  // See: https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
  // The CF Telemetry API requires filters, orderBy, needle, etc. inside a `parameters` object.
  // Top-level fields are: queryId, timeframe, view, limit, parameters.
  const filters: Array<{ key: string; operation: string; type: string; value: unknown }> = [];

  if (input.levels && input.levels.length > 0) {
    filters.push({
      key: '$workers.event.level',
      operation: 'in',
      type: 'string',
      value: input.levels,
    });
  }

  if (input.scriptName) {
    filters.push({
      key: '$workers.scriptName',
      operation: 'eq',
      type: 'string',
      value: input.scriptName,
    });
  }

  const parameters: Record<string, unknown> = {
    datasets: [],
    filters,
    orderBy: { value: 'timestamp', order: 'desc' },
    limit,
  };

  // Use needle for full-text search (the CF API's dedicated search mechanism)
  if (input.search) {
    parameters.needle = {
      value: input.search,
      isRegex: false,
      matchCase: false,
    };
  }

  const body: Record<string, unknown> = {
    queryId,
    timeframe: {
      from: new Date(input.timeRange.start).getTime(),
      to: new Date(input.timeRange.end).getTime(),
    },
    view: 'events',
    limit,
    parameters,
  };

  if (input.cursor) {
    body.offset = input.cursor;
  }

  const url = `${CF_OBSERVABILITY_API_BASE}/${input.cfAccountId}/workers/observability/telemetry/query`;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.cfApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      input.timeoutMs,
      input.callerSignal
    );
  } catch {
    // Network error — return 502-style error without leaking details
    throw new CfApiError('Cloudflare Observability API is unreachable');
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new CfApiError(
        'Cloudflare Observability API returned 403: The CF_API_TOKEN is missing the "Account: Workers Observability (Read)" permission. ' +
          'Edit the API token in Cloudflare Dashboard to add this permission.'
      );
    }
    if (response.status === 401) {
      throw new CfApiError(
        'Cloudflare Observability API returned 401: The CF_API_TOKEN is invalid or expired. ' +
          'Regenerate the token in Cloudflare Dashboard.'
      );
    }
    let detail = '';
    try {
      const errBody = await response.text();
      if (errBody) detail = `: ${errBody.slice(0, 200)}`;
    } catch {
      /* ignore */
    }
    throw new CfApiError(`Cloudflare Observability API returned ${response.status}${detail}`);
  }

  let data: Record<string, unknown>;
  try {
    data = expectJsonRecord(await response.json(), 'cloudflare.observability');
  } catch {
    throw new CfApiError('Invalid response from Cloudflare Observability API');
  }

  // Normalize CF response to our LogQueryResponse shape.
  // The CF Telemetry API response structure (from cloudflare-typescript SDK):
  //   result.events.events — array of telemetry event objects
  //   Each event: { $metadata: { id, level, message, type, ... }, $workers: { scriptName, event, ... }, timestamp, dataset, source }
  const result = optionalJsonRecord(data.result, 'cloudflare.observability.result');

  // Extract events: result.events.events (new format) or result.events (legacy fallback)
  let events: Array<Record<string, unknown>> = [];
  const eventsContainer = result?.events;
  if (Array.isArray(eventsContainer)) {
    // Legacy format: result.events is directly an array
    events = eventsContainer.map((event, index) =>
      expectJsonRecord(event, `cloudflare.observability.result.events[${index}]`)
    );
  } else if (
    eventsContainer &&
    typeof eventsContainer === 'object' &&
    !Array.isArray(eventsContainer) &&
    Array.isArray((eventsContainer as { events?: unknown }).events)
  ) {
    // New format: result.events.events is the array
    events = (eventsContainer as { events: unknown[] }).events.map((event, index) =>
      expectJsonRecord(event, `cloudflare.observability.result.events.events[${index}]`)
    );
  } else if (result?.data && Array.isArray(result.data)) {
    // Fallback: result.data
    events = result.data.map((event, index) =>
      expectJsonRecord(event, `cloudflare.observability.result.data[${index}]`)
    );
  }

  // Extract cursor for pagination from the run object
  const run = optionalJsonRecord(result?.run, 'cloudflare.observability.result.run');
  const rawCursor = run?.offset ?? result?.cursor ?? data.cursor ?? null;
  const nextCursor = typeof rawCursor === 'string' ? rawCursor : null;

  const logs = events.map((event) => {
    // New format: $metadata contains level, message, type; $workers contains scriptName, event details
    const metadata = optionalJsonRecord(
      event.$metadata,
      'cloudflare.observability.event.$metadata'
    );
    const workers = optionalJsonRecord(event.$workers, 'cloudflare.observability.event.$workers');
    const workerEvent = optionalJsonRecord(
      workers?.event,
      'cloudflare.observability.event.$workers.event'
    );
    // Legacy format fallback
    const legacyEvent = optionalJsonRecord(event.event, 'cloudflare.observability.event.event');

    const timestamp = event.timestamp;
    const timestampStr =
      typeof timestamp === 'number'
        ? new Date(timestamp).toISOString()
        : ((timestamp ?? event.eventTimestamp ?? '') as string);

    return {
      timestamp: timestampStr,
      level: (metadata?.level ?? legacyEvent?.level ?? event.level ?? 'info') as string,
      event: (metadata?.type ??
        workers?.eventType ??
        legacyEvent?.type ??
        event.type ??
        'unknown') as string,
      message: (metadata?.message ?? legacyEvent?.message ?? event.message ?? '') as string,
      details: redactSensitiveData({
        ...(workerEvent ?? legacyEvent ?? {}),
        scriptName: workers?.scriptName,
        requestId: metadata?.requestId ?? workers?.requestId,
        outcome: workers?.outcome,
      }),
      invocationId: (metadata?.requestId ??
        workers?.requestId ??
        event.invocationId ??
        event.traceId) as string | undefined,
    };
  });

  return {
    logs,
    cursor: nextCursor,
    hasMore: nextCursor !== null && logs.length >= limit,
    queryId,
  };
}
