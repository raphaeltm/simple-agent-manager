/**
 * Internal observability log ingest route.
 *
 * This endpoint receives batched log entries from the Tail Worker via service
 * binding and forwards them to the AdminLogs DO for WebSocket broadcasting.
 *
 * It is mounted separately from adminRoutes to avoid the superadmin session
 * auth middleware — service binding requests carry no browser session. Instead,
 * access is restricted to internal (service binding) callers by verifying that
 * the request URL hostname contains no dots, which is only possible for
 * synthetic URLs used by Cloudflare service bindings (e.g. `https://internal/...`).
 * Public HTTP traffic always arrives with a real hostname (`api.example.com`).
 */
import { Hono } from 'hono';

import type { Env } from '../env';

const observabilityIngestRoutes = new Hono<{ Bindings: Env }>();

/**
 * Middleware: require that the request originates from a service binding.
 *
 * Service binding fetches use synthetic hostnames without dots (e.g. `internal`).
 * Public HTTP always arrives via a real DNS hostname containing at least one dot.
 * Cloudflare edge routing ensures external traffic cannot reach a Worker with a
 * dotless hostname — there is no DNS record or route to match.
 */
observabilityIngestRoutes.use('/*', async (c, next) => {
  const url = new URL(c.req.url);

  // Service binding: synthetic hostname has no dots (e.g. "internal")
  if (!url.hostname.includes('.')) {
    await next();
    return;
  }

  return c.json({ error: 'UNAUTHORIZED', message: 'Internal endpoint' }, 401);
});

/**
 * POST /api/admin/observability/logs/ingest - Internal endpoint for Tail Worker
 *
 * Receives batched log entries from the Tail Worker and forwards them
 * to the AdminLogs DO for broadcasting to connected WebSocket clients.
 * This endpoint is called via service binding, not external HTTP.
 */
observabilityIngestRoutes.post('/', async (c) => {
  const doId = c.env.ADMIN_LOGS.idFromName('admin-logs');
  const doStub = c.env.ADMIN_LOGS.get(doId);

  const doUrl = new URL(c.req.url);
  doUrl.pathname = '/ingest';
  const body = await c.req.text();

  const response = await doStub.fetch(new Request(doUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }));

  return new Response(response.body, { status: response.status });
});

export { observabilityIngestRoutes };
