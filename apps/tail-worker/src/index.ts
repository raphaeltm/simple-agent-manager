/**
 * Tail Worker — receives log events from the API Worker and forwards them
 * to the AdminLogs Durable Object for real-time WebSocket broadcasting.
 *
 * Registered as a tail_consumer in the API Worker's wrangler.toml
 * (staging/production environments only — NOT dev, as tail_consumers breaks Vitest).
 *
 * See specs/023-admin-observability/research.md (R2) for architecture details.
 */

export interface Env {
  // Service binding to the API Worker (for AdminLogs DO access)
  API_WORKER?: Fetcher;
  // How long (ms) to trust a cached zero-subscriber count before re-probing.
  // While the cache is fresh AND reports zero connected admins, the worker
  // skips forwarding entirely (broadcasting to nobody is pure waste). Once the
  // cache goes stale the worker forwards again to refresh the count, bounding
  // the latency before a newly-connected admin starts seeing live logs.
  TAIL_SUBSCRIBER_CACHE_MS?: string;
}

/** Default subscriber-count cache TTL when TAIL_SUBSCRIBER_CACHE_MS is unset. */
const DEFAULT_SUBSCRIBER_CACHE_MS = 5_000;

/**
 * Resolve the cache TTL from the env var, honoring explicit values.
 *
 * A `parseInt(...) || DEFAULT` shortcut is wrong here: it silently maps `'0'`
 * back to the default and lets negatives through. We want `0` to be a usable
 * escape hatch (TTL of zero makes the cache never fresh, disabling the gate so
 * every invocation forwards), and any unparseable or negative value to fall
 * back to the documented default.
 */
function resolveCacheTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SUBSCRIBER_CACHE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_SUBSCRIBER_CACHE_MS;
  return parsed;
}

/**
 * Module-global cache of the last observed connected-admin count.
 *
 * `count === null` means "unknown" — never skip forwarding when unknown. A
 * known `count === 0` within the TTL window is the only state that gates
 * forwarding off.
 */
const subscriberCache: { count: number | null; ts: number } = { count: null, ts: 0 };

export interface TailWorkerEvent {
  type: 'log';
  entry: {
    timestamp: string;
    level: string;
    event: string;
    message: string;
    details: Record<string, unknown>;
    scriptName: string;
  };
}

type AcceptedLogLevel = 'error' | 'warn' | 'info';

const ACCEPTED_LEVELS = new Set<AcceptedLogLevel>(['error', 'warn', 'info']);

function normalizeConsoleLevel(level: unknown): AcceptedLogLevel | null {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  if (level === 'log' || level === 'info') return 'info';
  return null;
}

function normalizeStructuredLevel(level: unknown, fallback: AcceptedLogLevel): AcceptedLogLevel {
  return typeof level === 'string' && ACCEPTED_LEVELS.has(level as AcceptedLogLevel)
    ? (level as AcceptedLogLevel)
    : fallback;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

function stringifyMessagePart(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}

function safeJoinMessage(message: unknown): string {
  if (Array.isArray(message)) return message.map(stringifyMessagePart).join(' ');
  return stringifyMessagePart(message);
}

function parseDate(value: unknown): Date | null {
  try {
    const parsed = new Date(value as string | number | Date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

function safeIsoTimestamp(timestamp: unknown, fallbackTimestamp: unknown): string {
  const parsed = parseDate(timestamp);
  if (parsed) return parsed.toISOString();

  // Prefer the trace event timestamp when a malformed log timestamp is present;
  // tests can provide it deterministically, and Date.now() remains the last resort.
  return (parseDate(fallbackTimestamp) ?? new Date()).toISOString();
}

function parseStructuredMessage(message: unknown): Record<string, unknown> {
  if (!Array.isArray(message) || typeof message[0] !== 'string') return {};

  try {
    const json = JSON.parse(message[0]) as unknown;
    return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function successfulSubscriberCount(response: Response, result: unknown): number | null {
  if (!response.ok || typeof result !== 'object' || result === null) return null;
  const subscribers = (result as { subscribers?: unknown }).subscribers;
  return typeof subscribers === 'number' && Number.isFinite(subscribers) && subscribers >= 0
    ? subscribers
    : null;
}

export default {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    // Extract log-level events from trace items
    const logEntries: TailWorkerEvent[] = [];

    for (const event of events) {
      if (!Array.isArray(event.logs)) continue;

      for (const log of event.logs) {
        let level = normalizeConsoleLevel(log.level);
        if (level === null) continue; // skip debug/trace and unknown levels

        const rawMessage = safeJoinMessage(log.message);
        const parsed = parseStructuredMessage(log.message);
        const structuredMessage = nonEmptyString(parsed.message);
        const structuredEvent = nonEmptyString(parsed.event);

        const message = structuredMessage ?? structuredEvent ?? rawMessage;
        const eventName = structuredEvent ?? 'log';
        level = normalizeStructuredLevel(parsed.level, level);

        logEntries.push({
          type: 'log',
          entry: {
            timestamp: safeIsoTimestamp(log.timestamp, event.eventTimestamp),
            level,
            event: eventName,
            message,
            details: parsed,
            scriptName: event.scriptName || 'unknown',
          },
        });
      }
    }

    if (logEntries.length === 0) return;

    if (!env.API_WORKER) return;

    // Subscriber-aware gate: when we recently observed zero connected admins,
    // skip forwarding — broadcasting to an empty WebSocket fan-out is pure
    // waste and was the source of the clientDisconnected firehose. The cache
    // expires after TAIL_SUBSCRIBER_CACHE_MS so we periodically re-probe and
    // resume forwarding promptly once an admin connects.
    const cacheTtlMs = resolveCacheTtlMs(env.TAIL_SUBSCRIBER_CACHE_MS);
    const cacheFresh = Date.now() - subscriberCache.ts < cacheTtlMs;
    if (cacheFresh && subscriberCache.count === 0) {
      return;
    }

    // Forward to AdminLogs DO via the API Worker service binding
    try {
      const response = await env.API_WORKER.fetch(
        'https://internal/api/admin/observability/logs/ingest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: logEntries }),
        }
      );

      // Consume the response body to completion. The ingest endpoint returns a
      // fully-buffered JSON body carrying the connected-subscriber count; not
      // reading it would tear down the connection and record the upstream
      // invocation as `canceled`/clientDisconnected.
      const result = await response.json().catch(() => null);
      const subscribers = successfulSubscriberCount(response, result);
      if (subscribers !== null) {
        subscriberCache.count = subscribers;
        subscriberCache.ts = Date.now();
      }
    } catch (err) {
      // Fail silently — tail workers must not throw
      console.error('[tail-worker] Failed to forward logs to AdminLogs DO:', err);
    }
  },
};
