/**
 * GET /api/trial/:trialId/events — Server-Sent Events stream for a trial.
 *
 * Auth model: fingerprint-cookie-based. The endpoint rejects any request whose
 * `sam_trial_fingerprint` cookie does NOT cryptographically bind to the trial's
 * recorded fingerprint. This fails closed — no fingerprint cookie => 401.
 *
 * Stream semantics:
 *   - `content-type: text/event-stream` + `cache-control: no-cache`
 *   - Comment-only heartbeats every TRIAL_SSE_HEARTBEAT_MS (default 15s)
 *   - Events are sourced from the per-trial TrialEventBus DO via long-poll
 *   - Terminates cleanly after `trial.ready` / `trial.error` is observed
 *   - Hard duration cap (TRIAL_SSE_MAX_DURATION_MS, default 30 min) to avoid
 *     runaway connections
 */

import type { TrialEvent } from '@simple-agent-manager/shared';
import { TRIAL_COOKIE_FINGERPRINT_NAME } from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
  getRateLimit,
} from '../../middleware/rate-limit';
import { verifyFingerprint } from '../../services/trial/cookies';
import { readTrial } from '../../services/trial/trial-store';

const eventsRoutes = new Hono<{ Bindings: Env }>();

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000; // 30 min
const SSE_RATE_LIMIT_WINDOW_SECONDS = 300; // 5-minute window

eventsRoutes.get('/:trialId/events', async (c) => {
  const trialId = c.req.param('trialId');
  if (!trialId) throw errors.badRequest('trialId is required');

  // Rate limit: per-IP to prevent SSE connection storms from a single source
  const clientIp = c.req.header('CF-Connecting-IP')
    ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    ?? 'unknown';
  const sseLimit = getRateLimit(c.env, 'TRIAL_SSE');
  const windowStart = getCurrentWindowStart(SSE_RATE_LIMIT_WINDOW_SECONDS);
  const rateLimitKey = createRateLimitKey('trial-sse', clientIp, windowStart);
  const { allowed } = await checkRateLimit(c.env.KV, rateLimitKey, sseLimit, SSE_RATE_LIMIT_WINDOW_SECONDS);
  if (!allowed) {
    return c.json({ error: 'Too many SSE connections. Please try again later.' }, 429);
  }

  // Resolve trial record
  const record = await readTrial(c.env, trialId);
  if (!record) throw errors.notFound('Trial');

  // Fingerprint auth — fail closed
  const secret = c.env.TRIAL_CLAIM_TOKEN_SECRET;
  if (!secret) {
    log.error('trial_events.secret_unset', { trialId });
    throw errors.internal('Trial auth secret is not configured');
  }

  const cookieHeader = c.req.header('cookie') ?? '';
  const fingerprintCookie = parseCookie(cookieHeader, TRIAL_COOKIE_FINGERPRINT_NAME);
  if (!fingerprintCookie) {
    throw errors.unauthorized('Missing trial fingerprint');
  }
  const uuid = await verifyFingerprint(fingerprintCookie, secret);
  if (!uuid || uuid !== record.fingerprint) {
    throw errors.unauthorized('Trial fingerprint does not match this trial');
  }

  // Build SSE stream
  const heartbeatMs = parseIntSafe(c.env.TRIAL_SSE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
  const pollTimeoutMs = parseIntSafe(c.env.TRIAL_SSE_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS);
  const maxDurationMs = parseIntSafe(c.env.TRIAL_SSE_MAX_DURATION_MS, DEFAULT_MAX_DURATION_MS);

  const encoder = new TextEncoder();
  const busStub = c.env.TRIAL_EVENT_BUS.get(c.env.TRIAL_EVENT_BUS.idFromName(trialId));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cursor = 0;
      const startedAt = Date.now();

      const enqueue = (bytes: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(bytes);
        } catch {
          closed = true;
        }
      };

      // Initial comment — flushes headers and helps with proxies.
      enqueue(encoder.encode(': connected\n\n'));

      // Heartbeat timer — comment frames are ignored by EventSource but keep
      // the TCP connection alive across CDN buffering.
      const heartbeat = setInterval(() => {
        enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, heartbeatMs);

      try {
        while (!closed && Date.now() - startedAt < maxDurationMs) {
          let pollResp: Response;
          try {
            pollResp = await busStub.fetch(
              `https://trial-event-bus/poll?cursor=${cursor}&timeoutMs=${pollTimeoutMs}`,
              { method: 'GET' }
            );
          } catch (err) {
            log.warn('trial_events.poll_error', {
              trialId,
              error: err instanceof Error ? err.message : String(err),
            });
            // Brief back-off so we don't spin on DO errors.
            await sleep(1000);
            continue;
          }

          if (!pollResp.ok) {
            enqueue(encoder.encode(formatSse('error', {
              type: 'trial.error',
              error: 'invalid_url',
              message: `Event bus poll failed: ${pollResp.status}`,
              at: Date.now(),
            })));
            break;
          }

          const data = (await pollResp.json()) as {
            events: { cursor: number; event: TrialEvent }[];
            cursor: number;
            closed: boolean;
          };

          for (const { cursor: c2, event } of data.events) {
            enqueue(encoder.encode(formatSse(event.type, event)));
            cursor = c2;
          }

          if (data.closed) break;
        }
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      // client disconnected — nothing to clean up beyond the start() finally.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCookie(header: string, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function formatSse(_eventName: string, data: unknown): string {
  // Emit as the default ("message") SSE event so that EventSource consumers
  // receive the payload via `source.onmessage`. Using a named `event:` field
  // would require the client to register `addEventListener(<type>, ...)` for
  // every TrialEvent variant, and `onmessage` would silently never fire —
  // the exact "zero events on staging" symptom that motivated this fix.
  //
  // The TrialEvent JSON payload itself carries a `type` discriminator, so
  // dropping the `event:` line loses no information. Data is JSON-encoded
  // which already escapes newlines, preventing SSE-frame injection.
  const json = JSON.stringify(data);
  return `data: ${json}\n\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { eventsRoutes };
