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

const ACCEPTED_LEVELS = new Set(['error', 'warn', 'info']);

export default {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    // Extract log-level events from trace items
    const logEntries: TailWorkerEvent[] = [];

    for (const event of events) {
      if (!event.logs) continue;

      for (const log of event.logs) {
        // Map console methods to log levels
        let level: string;
        if (log.level === 'error') level = 'error';
        else if (log.level === 'warn') level = 'warn';
        else if (log.level === 'log' || log.level === 'info') level = 'info';
        else continue; // skip debug/trace

        if (!ACCEPTED_LEVELS.has(level)) continue;

        // Try to parse structured JSON log messages
        const rawMessage = log.message.join(' ');
        let parsed: Record<string, unknown> = {};
        let message = rawMessage;
        let eventName = 'log';

        try {
          const json = JSON.parse(log.message[0]);
          if (typeof json === 'object' && json !== null) {
            parsed = json;
            message = json.message || json.event || rawMessage;
            eventName = json.event || 'log';
            if (json.level) level = json.level;
          }
        } catch {
          // Not structured JSON, use raw message
        }

        logEntries.push({
          type: 'log',
          entry: {
            timestamp: new Date(log.timestamp).toISOString(),
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
      const response = await env.API_WORKER.fetch('https://internal/api/admin/observability/logs/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: logEntries }),
      });

      // Consume the response body to completion. The ingest endpoint returns a
      // fully-buffered JSON body carrying the connected-subscriber count; not
      // reading it would tear down the connection and record the upstream
      // invocation as `canceled`/clientDisconnected.
      const result = (await response.json().catch(() => null)) as { subscribers?: number } | null;
      if (result && typeof result.subscribers === 'number') {
        subscriberCache.count = result.subscribers;
        subscriberCache.ts = Date.now();
      }
    } catch (err) {
      // Fail silently — tail workers must not throw
      console.error('[tail-worker] Failed to forward logs to AdminLogs DO:', err);
    }
  },
};
