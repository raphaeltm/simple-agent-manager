/**
 * Internal observability log ingest route.
 *
 * This endpoint receives batched log entries from the Tail Worker via service
 * binding and forwards them to the AdminLogs DO for WebSocket broadcasting.
 *
 * It is mounted separately from adminRoutes to avoid the superadmin session
 * auth middleware — service binding requests carry no browser session. Instead,
 * access is restricted to the exact synthetic hostname used by our tail worker's
 * service binding (`https://internal/...`). Public HTTP traffic always arrives
 * with a real DNS hostname (`api.example.com`) and is rejected.
 */
import { Hono } from 'hono';

import type { Env } from '../env';

/** Hostnames used by our service bindings. The tail worker uses `internal`. */
const ALLOWED_INTERNAL_HOSTS = new Set(['internal']);

/** Maximum ingest body size (1 MB) — tail worker batches are well under this. */
const MAX_INGEST_BYTES = 1_048_576;

const observabilityIngestRoutes = new Hono<{ Bindings: Env }>();

/**
 * Middleware: require that the request originates from our service binding.
 *
 * The tail worker calls this endpoint via `env.API_WORKER.fetch('https://internal/...')`.
 * We allow only the explicit hostname `internal` — not any dotless hostname —
 * to prevent potential bypass via `localhost` or IPv6 literals.
 */
observabilityIngestRoutes.use('/*', async (c, next) => {
  const url = new URL(c.req.url);

  if (ALLOWED_INTERNAL_HOSTS.has(url.hostname)) {
    await next();
    return;
  }

  return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
});

/**
 * POST /api/admin/observability/logs/ingest - Internal endpoint for Tail Worker
 *
 * Receives batched log entries from the Tail Worker and forwards them
 * to the AdminLogs DO for broadcasting to connected WebSocket clients.
 * This endpoint is called via service binding, not external HTTP.
 */
observabilityIngestRoutes.post('/', async (c) => {
  const contentLength = parseInt(c.req.header('content-length') ?? '0', 10);
  if (contentLength > MAX_INGEST_BYTES) {
    return c.json({ error: 'PAYLOAD_TOO_LARGE', message: 'Body exceeds 1 MB limit' }, 413);
  }

  const doId = c.env.ADMIN_LOGS.idFromName('admin-logs');
  const doStub = c.env.ADMIN_LOGS.get(doId);

  const doUrl = new URL('/ingest', 'https://do-internal');
  const body = await c.req.text();

  if (body.length > MAX_INGEST_BYTES) {
    return c.json({ error: 'PAYLOAD_TOO_LARGE', message: 'Body exceeds 1 MB limit' }, 413);
  }

  const response = await doStub.fetch(new Request(doUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }));

  return new Response(response.body, { status: response.status });
});

export { observabilityIngestRoutes };
