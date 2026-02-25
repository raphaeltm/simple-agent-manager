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
}

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
  async tail(events: TraceItem[], _env: Env): Promise<void> {
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

    // Forward to AdminLogs DO via the API Worker service binding
    // Implementation will be completed in Phase 6 (US4) when AdminLogs DO exists
    // For now, just log the count for verification
    console.log(`[tail-worker] Processed ${logEntries.length} log entries`);
  },
};
