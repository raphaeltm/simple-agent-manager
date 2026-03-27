/**
 * Analytics Engine Phase 4 — External Event Forwarding
 *
 * Queries Analytics Engine for recent conversion events and forwards them
 * to configured external platforms (Segment, GA4) in batches.
 *
 * Runs daily via cron. Uses a KV cursor to avoid re-sending events.
 */
import type { Env } from '../index';

// ─── Defaults (configurable via env vars per constitution Principle XI) ───

const DEFAULT_FORWARD_EVENTS = [
  'signup', 'login', 'project_created',
  'workspace_created', 'task_submitted',
].join(',');

const DEFAULT_LOOKBACK_HOURS = 25; // Overlap to catch late-arriving events
const DEFAULT_CURSOR_KEY = 'analytics-forward-cursor';
const DEFAULT_SEGMENT_API_URL = 'https://api.segment.io/v1/batch';
const DEFAULT_SEGMENT_MAX_BATCH = 100;
const DEFAULT_GA4_API_URL = 'https://www.google-analytics.com/mp/collect';
const DEFAULT_GA4_MAX_BATCH = 25;
const DEFAULT_ANALYTICS_SQL_API_URL = 'https://api.cloudflare.com/client/v4/accounts';
const DEFAULT_DATASET = 'sam_analytics';
const DEFAULT_FORWARD_SQL_LIMIT = 10_000;
const DEFAULT_FORWARD_FETCH_TIMEOUT_MS = 30_000;

// ─── Types ───

export interface AnalyticsEvent {
  timestamp: string;
  userId: string;
  event: string;
  projectId: string;
  route: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  country: string;
  responseTimeMs: number;
  statusCode: number;
}

export interface ForwardResult {
  enabled: boolean;
  eventsQueried: number;
  segment: { sent: number; batches: number; enabled: boolean; error?: string };
  ga4: { sent: number; batches: number; enabled: boolean; error?: string };
  cursorUpdated: boolean;
  newCursor: string | null;
}

// ─── Helpers ───

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Validate that a string is a valid ISO 8601 timestamp to prevent SQL injection via corrupted cursor. */
function assertIsoTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    throw new Error(`Invalid ISO timestamp for cursor: ${value}`);
  }
}

/**
 * Query Analytics Engine SQL API for conversion events since a given timestamp.
 */
export async function queryConversionEvents(
  env: Env,
  sinceIso: string,
  eventNames: string[],
): Promise<AnalyticsEvent[]> {
  const baseUrl = env.ANALYTICS_SQL_API_URL ?? DEFAULT_ANALYTICS_SQL_API_URL;
  const accountId = env.CF_ACCOUNT_ID;
  const dataset = env.ANALYTICS_DATASET ?? DEFAULT_DATASET;

  if (!accountId) {
    throw new Error('CF_ACCOUNT_ID is not configured');
  }

  // Validate sinceIso to prevent SQL injection via corrupted KV cursor
  assertIsoTimestamp(sinceIso);

  // Build IN clause for event names
  const eventList = eventNames.map(e => `'${e.replace(/'/g, "''")}'`).join(', ');
  // SQL LIMIT is the memory-safety guard for downstream in-memory grouping (GA4 Map)
  const sqlLimit = parsePositiveInt(env.ANALYTICS_FORWARD_SQL_LIMIT, DEFAULT_FORWARD_SQL_LIMIT);
  const fetchTimeoutMs = parsePositiveInt(env.ANALYTICS_SQL_FETCH_TIMEOUT_MS, DEFAULT_FORWARD_FETCH_TIMEOUT_MS);

  const sql = `
    SELECT
      timestamp,
      index1 AS userId,
      blob1 AS event,
      blob2 AS projectId,
      blob3 AS route,
      blob5 AS utmSource,
      blob6 AS utmMedium,
      blob7 AS utmCampaign,
      blob10 AS country,
      double1 AS responseTimeMs,
      double2 AS statusCode
    FROM ${dataset}
    WHERE blob1 IN (${eventList})
      AND timestamp >= '${sinceIso}'
      AND index1 != 'anonymous'
    ORDER BY timestamp ASC
    LIMIT ${sqlLimit}
  `;

  const url = `${baseUrl}/${accountId}/analytics_engine/sql`;
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(fetchTimeoutMs),
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  });

  if (!response.ok) {
    const body = await response.text();
    console.error('Analytics forward: SQL API error', {
      status: response.status,
      body: body.slice(0, 500),
    });
    throw new Error(`Analytics Engine query failed: ${response.status}`);
  }

  const body = await response.json() as { data?: unknown[] };
  const rows = body.data ?? [];

  // Validate shape: first row must have the expected fields
  if (rows.length > 0) {
    const first = rows[0] as Record<string, unknown>;
    if (typeof first.timestamp !== 'string' || typeof first.userId !== 'string') {
      console.error('Analytics forward: unexpected SQL API response shape', {
        firstRowKeys: Object.keys(first),
      });
      return [];
    }
  }

  return rows as AnalyticsEvent[];
}

// ─── Segment Forwarding ───

interface SegmentTrackCall {
  type: 'track';
  userId: string;
  event: string;
  timestamp: string;
  properties: Record<string, string | number>;
  context: { library: { name: string; version: string } };
}

function formatSegmentBatch(events: AnalyticsEvent[]): SegmentTrackCall[] {
  return events.map(e => ({
    type: 'track' as const,
    userId: e.userId,
    event: e.event,
    timestamp: e.timestamp,
    properties: {
      projectId: e.projectId,
      route: e.route,
      utmSource: e.utmSource,
      utmMedium: e.utmMedium,
      utmCampaign: e.utmCampaign,
      country: e.country,
      responseTimeMs: e.responseTimeMs,
      statusCode: e.statusCode,
    },
    context: {
      // Constitution XI: library identifier tied to deployment artifact — invariant
      library: { name: 'sam-analytics-forward', version: '1.0.0' },
    },
  }));
}

export async function forwardToSegment(
  env: Env,
  events: AnalyticsEvent[],
): Promise<{ sent: number; batches: number; error?: string }> {
  const writeKey = env.SEGMENT_WRITE_KEY;
  if (!writeKey) {
    return { sent: 0, batches: 0 };
  }

  const apiUrl = env.SEGMENT_API_URL ?? DEFAULT_SEGMENT_API_URL;
  const maxBatch = parsePositiveInt(env.SEGMENT_MAX_BATCH_SIZE, DEFAULT_SEGMENT_MAX_BATCH);
  const fetchTimeoutMs = parsePositiveInt(env.SEGMENT_FETCH_TIMEOUT_MS, DEFAULT_FORWARD_FETCH_TIMEOUT_MS);
  const authHeader = `Basic ${btoa(writeKey + ':')}`;

  let totalSent = 0;
  let batchCount = 0;

  for (let i = 0; i < events.length; i += maxBatch) {
    const chunk = events.slice(i, i + maxBatch);
    const batch = formatSegmentBatch(chunk);

    const response = await fetch(apiUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ batch }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('Analytics forward: Segment API error', {
        status: response.status,
        body: body.slice(0, 500),
        batchSize: chunk.length,
      });
      return {
        sent: totalSent,
        batches: batchCount,
        error: `Segment API returned ${response.status} on batch ${batchCount + 1}`,
      };
    }

    totalSent += chunk.length;
    batchCount++;
  }

  return { sent: totalSent, batches: batchCount };
}

// ─── GA4 Forwarding ───

interface GA4Event {
  name: string;
  params: Record<string, string | number>;
}

function formatGA4Events(events: AnalyticsEvent[]): { clientId: string; userId: string; events: GA4Event[] }[] {
  // GA4 requires grouping by client_id (we use userId)
  // Each request can have max 25 events, all sharing the same client_id
  const byUser = new Map<string, AnalyticsEvent[]>();
  for (const e of events) {
    const existing = byUser.get(e.userId) ?? [];
    existing.push(e);
    byUser.set(e.userId, existing);
  }

  const requests: { clientId: string; userId: string; events: GA4Event[] }[] = [];
  for (const [userId, userEvents] of byUser) {
    const ga4Events: GA4Event[] = userEvents.map(e => ({
      name: e.event,
      params: {
        project_id: e.projectId,
        route: e.route,
        utm_source: e.utmSource,
        utm_medium: e.utmMedium,
        utm_campaign: e.utmCampaign,
        country: e.country,
        response_time_ms: e.responseTimeMs,
        status_code: e.statusCode,
      },
    }));
    requests.push({ clientId: userId, userId, events: ga4Events });
  }

  return requests;
}

export async function forwardToGA4(
  env: Env,
  events: AnalyticsEvent[],
): Promise<{ sent: number; batches: number; error?: string }> {
  const measurementId = env.GA4_MEASUREMENT_ID;
  const apiSecret = env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) {
    return { sent: 0, batches: 0 };
  }

  const baseUrl = env.GA4_API_URL ?? DEFAULT_GA4_API_URL;
  const maxBatch = parsePositiveInt(env.GA4_MAX_BATCH_SIZE, DEFAULT_GA4_MAX_BATCH);
  const fetchTimeoutMs = parsePositiveInt(env.GA4_FETCH_TIMEOUT_MS, DEFAULT_FORWARD_FETCH_TIMEOUT_MS);
  const url = `${baseUrl}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  let totalSent = 0;
  let batchCount = 0;

  // GA4 groups events per client_id, max 25 events per request
  const grouped = formatGA4Events(events);

  for (const group of grouped) {
    // Split per-user events into chunks of maxBatch
    for (let i = 0; i < group.events.length; i += maxBatch) {
      const chunk = group.events.slice(i, i + maxBatch);
      const payload = {
        client_id: group.clientId,
        user_id: group.userId,
        events: chunk,
      };

      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(fetchTimeoutMs),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // GA4 Measurement Protocol returns 2xx even for invalid events
      // but we still check for network/server errors
      if (!response.ok) {
        const body = await response.text();
        console.error('Analytics forward: GA4 API error', {
          status: response.status,
          body: body.slice(0, 500),
          batchSize: chunk.length,
        });
        return {
          sent: totalSent,
          batches: batchCount,
          error: `GA4 API returned ${response.status} on batch ${batchCount + 1}`,
        };
      }

      totalSent += chunk.length;
      batchCount++;
    }
  }

  return { sent: totalSent, batches: batchCount };
}

// ─── Orchestrator ───

/**
 * Main forwarding orchestrator. Called by the daily cron job.
 *
 * 1. Read cursor from KV (last forwarded timestamp)
 * 2. Query Analytics Engine for events since cursor
 * 3. Forward to enabled destinations (Segment, GA4)
 * 4. Update cursor in KV
 */
export async function runAnalyticsForward(env: Env): Promise<ForwardResult> {
  const enabled = (env.ANALYTICS_FORWARD_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) {
    return {
      enabled: false,
      eventsQueried: 0,
      segment: { sent: 0, batches: 0, enabled: false },
      ga4: { sent: 0, batches: 0, enabled: false },
      cursorUpdated: false,
      newCursor: null,
    };
  }

  const cursorKey = env.ANALYTICS_FORWARD_CURSOR_KEY ?? DEFAULT_CURSOR_KEY;
  const lookbackHours = parsePositiveInt(env.ANALYTICS_FORWARD_LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS);
  const eventNames = (env.ANALYTICS_FORWARD_EVENTS ?? DEFAULT_FORWARD_EVENTS)
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  // Read cursor — fall back to lookback window if no cursor exists
  const storedCursor = await env.KV.get(cursorKey);
  const fallbackIso = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const sinceIso = storedCursor ?? fallbackIso;

  // Query events
  const events = await queryConversionEvents(env, sinceIso, eventNames);

  if (events.length === 0) {
    return {
      enabled: true,
      eventsQueried: 0,
      segment: { sent: 0, batches: 0, enabled: !!env.SEGMENT_WRITE_KEY },
      ga4: { sent: 0, batches: 0, enabled: !!(env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET) },
      cursorUpdated: false,
      newCursor: sinceIso,
    };
  }

  // Forward to enabled destinations
  const segmentEnabled = !!env.SEGMENT_WRITE_KEY;
  const ga4Enabled = !!(env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET);
  const segmentResult = await forwardToSegment(env, events);
  const ga4Result = await forwardToGA4(env, events);

  // Only advance cursor when ALL enabled destinations succeed without error.
  // This prevents silent data loss: if Segment succeeds but GA4 fails, we
  // re-query the same window next run so GA4 can retry. The trade-off is that
  // Segment may receive duplicate events on retry (idempotent for analytics).
  const segmentOk = !segmentEnabled || !segmentResult.error;
  const ga4Ok = !ga4Enabled || !ga4Result.error;
  const allEnabledSucceeded = (segmentOk && ga4Ok) && (segmentResult.sent > 0 || ga4Result.sent > 0);
  let newCursor = sinceIso;
  if (allEnabledSucceeded) {
    // Use the timestamp of the last event as the new cursor
    const lastEvent = events[events.length - 1];
    newCursor = lastEvent?.timestamp ?? sinceIso;
    // Cursor is intentionally long-lived (no TTL) — persists until next successful forward
    await env.KV.put(cursorKey, newCursor);
  }

  return {
    enabled: true,
    eventsQueried: events.length,
    segment: { ...segmentResult, enabled: segmentEnabled },
    ga4: { ...ga4Result, enabled: ga4Enabled },
    cursorUpdated: allEnabledSucceeded,
    newCursor,
  };
}

/**
 * Get the current forwarding status (for admin dashboard).
 */
export async function getForwardStatus(env: Env): Promise<{
  enabled: boolean;
  lastForwardedAt: string | null;
  destinations: {
    segment: { configured: boolean };
    ga4: { configured: boolean };
  };
  events: string[];
}> {
  const enabled = (env.ANALYTICS_FORWARD_ENABLED ?? 'false').toLowerCase() === 'true';
  const cursorKey = env.ANALYTICS_FORWARD_CURSOR_KEY ?? DEFAULT_CURSOR_KEY;
  const lastForwardedAt = await env.KV.get(cursorKey);
  const events = (env.ANALYTICS_FORWARD_EVENTS ?? DEFAULT_FORWARD_EVENTS)
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  return {
    enabled,
    lastForwardedAt,
    destinations: {
      segment: { configured: !!env.SEGMENT_WRITE_KEY },
      ga4: { configured: !!(env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET) },
    },
    events,
  };
}
