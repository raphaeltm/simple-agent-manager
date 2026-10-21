/**
 * SAM chat API routes.
 *
 * POST /turns — accept a private durable turn; GET /turns projects state
 * GET /conversations — list user's conversations
 * GET /conversations/:id/messages — get conversation history
 * GET /search — full-text search across conversation history
 */
import { DEFAULT_SAM_MAX_REQUEST_BODY_BYTES } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { expectJsonRecord } from '../lib/runtime-validation';
import { normalizeSearchQuery } from '../lib/search-query-limits';
import { requireApproved, requireAuth } from '../middleware/auth';
import { AgentChatRequestSchema, jsonValidator } from '../schemas';

const app = new Hono<{ Bindings: Env }>();

// All SAM routes require an approved account: chat spends the platform LLM budget.
app.use('/*', requireAuth(), requireApproved());
app.use('/*', (c, next) =>
  bodyLimit({
    maxSize: parsePositiveInt(c.env.SAM_MAX_REQUEST_BODY_BYTES, DEFAULT_SAM_MAX_REQUEST_BODY_BYTES),
    onError: (ctx) =>
      ctx.json(
        {
          error: 'request_too_large',
          message: 'SAM request exceeds the configured body limit',
          rejectedBeforeEffects: true,
        },
        413
      ),
  })(c, next)
);

/** Get the SamSession DO stub for the current user. */
function getSamSession(env: Env, userId: string): DurableObjectStub {
  const id = env.SAM_SESSION.idFromName(userId);
  return env.SAM_SESSION.get(id);
}

/** Private operator endpoints share the same authenticated per-user Durable Object. */
for (const path of [
  '/settings',
  '/fork',
  '/turns',
  '/turns/:id/cancel',
  '/actions/:id/confirm',
  '/actions/:id/reconcile',
  '/updates/:id/seen',
]) {
  app.all(path, async (c) => {
    const userId = c.get('auth').user.id;
    const incoming = new URL(c.req.url);
    const response = await getSamSession(c.env, userId).fetch(
      `https://sam-session${incoming.pathname.replace(/^\/api\/sam/, '')}${incoming.search}`,
      {
        method: c.req.method,
        headers: { 'content-type': 'application/json', 'x-sam-user-id': userId },
        body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.text(),
      }
    );
    return new Response(response.body, { status: response.status, headers: response.headers });
  });
}

/** Legacy transport relay; SamSession rejects inference and tells stale clients to refresh. */
app.post('/chat', jsonValidator(AgentChatRequestSchema), async (c) => {
  const userId = c.get('auth').user.id;
  const body = c.req.valid('json');

  if (!body.message?.trim()) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const stub = getSamSession(c.env, userId);
  const response = await stub.fetch('https://sam-session/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: body.conversationId,
      message: body.message,
      userId,
    }),
  });

  if (!response.ok)
    return new Response(response.body, { status: response.status, headers: response.headers });

  // Relay the SSE stream from the DO
  if (!response.body) {
    return c.json({ error: 'No response from SAM' }, 500);
  }

  return new Response(response.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
});

/** GET /conversations — list conversations (optionally filtered by type). */
app.get('/conversations', async (c) => {
  const userId = c.get('auth').user.id;
  const typeFilter = c.req.query('type') || '';
  const stub = getSamSession(c.env, userId);
  const url = typeFilter
    ? `https://sam-session/conversations?type=${encodeURIComponent(typeFilter)}`
    : 'https://sam-session/conversations';
  const response = await stub.fetch(url);
  const data = await response.json();
  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
});

/** GET /conversations/:id/messages — get messages for a conversation. */
app.get('/conversations/:id/messages', async (c) => {
  const userId = c.get('auth').user.id;
  const conversationId = c.req.param('id');
  const limit = c.req.query('limit') || '';
  const before = c.req.query('before') || '';
  const stub = getSamSession(c.env, userId);
  const url = limit
    ? `https://sam-session/conversations/${conversationId}/messages?limit=${encodeURIComponent(limit)}`
    : `https://sam-session/conversations/${conversationId}/messages`;
  const historyUrl = before
    ? `${url}${url.includes('?') ? '&' : '?'}before=${encodeURIComponent(before)}`
    : url;
  const response = await stub.fetch(historyUrl);
  const data = await response.json();
  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
});

/** GET /search — full-text search across conversation history. */
app.get('/search', async (c) => {
  const userId = c.get('auth').user.id;
  const inputQuery = c.req.query('query') || '';
  const limit = c.req.query('limit') || '';
  if (!inputQuery.trim()) {
    return c.json({ error: 'Query parameter is required' }, 400);
  }
  const normalizedQuery = normalizeSearchQuery(inputQuery, c.env);
  const stub = getSamSession(c.env, userId);
  const params = new URLSearchParams({ query: normalizedQuery.query });
  if (limit) params.set('limit', limit);
  const response = await stub.fetch(`https://sam-session/search?${params.toString()}`);
  const data = expectJsonRecord(await response.json(), 'sam.search.response');
  return new Response(JSON.stringify({ ...data, ...normalizedQuery }), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
});

export const samRoutes = app;
