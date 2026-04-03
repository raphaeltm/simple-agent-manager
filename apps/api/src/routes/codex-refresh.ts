/**
 * POST /api/auth/codex-refresh — Centralized Codex OAuth token refresh proxy.
 *
 * Receives refresh requests from Codex instances running in workspaces,
 * serializes them per user via a Durable Object, and proxies to OpenAI.
 * This prevents the rotating refresh token race condition where concurrent
 * refreshes permanently invalidate tokens.
 *
 * Auth: workspace callback token via `?token=` query param (Codex cannot set headers).
 * Codex sends hardcoded request format — we cannot change it.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { log } from '../lib/logger';
import { verifyCallbackToken } from '../services/jwt';

const codexRefreshRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /codex-refresh — Proxy Codex token refresh through SAM.
 *
 * Request format (hardcoded in Codex, cannot change):
 * {
 *   "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
 *   "grant_type": "refresh_token",
 *   "refresh_token": "<current-refresh-token>"
 * }
 *
 * Response format (what Codex expects):
 * {
 *   "access_token": "<new>",
 *   "refresh_token": "<new>",
 *   "id_token": "<new>"
 * }
 */
codexRefreshRoutes.post('/codex-refresh', async (c) => {
  // Kill switch check.
  if (c.env.CODEX_REFRESH_PROXY_ENABLED === 'false') {
    return c.json({ error: 'service_unavailable', message: 'Codex refresh proxy is disabled' }, 503);
  }

  // Auth: extract callback token from query param (Codex can't set headers).
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'invalid_request', message: 'Missing token query parameter' }, 401);
  }

  // Verify the callback token.
  let tokenPayload: { workspace: string; scope?: string };
  try {
    tokenPayload = await verifyCallbackToken(token, c.env);
  } catch {
    return c.json({ error: 'invalid_token' }, 401);
  }

  // Reject node-scoped tokens — only workspace-scoped tokens can access credentials.
  if (tokenPayload.scope === 'node') {
    log.error('codex_refresh.rejected_node_scoped_token', {
      tokenWorkspace: tokenPayload.workspace,
      scope: tokenPayload.scope,
    });
    return c.json({ error: 'insufficient_scope' }, 403);
  }

  const workspaceId = tokenPayload.workspace;

  // Parse the request body (Codex sends hardcoded format).
  let body: { client_id?: string; grant_type?: string; refresh_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  if (body.grant_type !== 'refresh_token' || !body.refresh_token) {
    return c.json({ error: 'invalid_request', message: 'Missing grant_type or refresh_token' }, 400);
  }

  // Look up workspace to get userId.
  const db = drizzle(c.env.DATABASE, { schema });
  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    log.error('codex_refresh.workspace_not_found', { workspaceId });
    return c.json({ error: 'refresh_token_invalidated' }, 401);
  }

  const userId = workspace.userId;

  log.info('codex_refresh.request_received', {
    workspaceId,
    userId,
  });

  // Forward to CodexRefreshLock DO keyed by userId for serialized refresh.
  // The DO derives the encryption key from its own env — no need to forward it.
  const doId = c.env.CODEX_REFRESH_LOCK.idFromName(userId);
  const stub = c.env.CODEX_REFRESH_LOCK.get(doId);

  const doRequest = new Request('https://do-internal/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refreshToken: body.refresh_token,
      userId,
    }),
  });

  const doResponse = await stub.fetch(doRequest);

  // Forward the DO response back to Codex.
  const responseBody = await doResponse.text();

  if (doResponse.ok) {
    log.info('codex_refresh.success', { workspaceId, userId });
  } else {
    log.warn('codex_refresh.upstream_error', {
      workspaceId,
      userId,
      status: doResponse.status,
    });
  }

  return new Response(responseBody, {
    status: doResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

export { codexRefreshRoutes };
