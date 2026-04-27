/**
 * SAM chat API routes.
 *
 * POST /chat — send a message to SAM, get SSE stream back
 * GET /conversations — list user's conversations
 * GET /conversations/:id/messages — get conversation history
 * GET /search — full-text search across conversation history
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { requireAuth } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

// All SAM routes require authentication
app.use('/*', requireAuth());

/** Get the SamSession DO stub for the current user. */
function getSamSession(env: Env, userId: string): DurableObjectStub {
  const id = env.SAM_SESSION.idFromName(userId);
  return env.SAM_SESSION.get(id);
}

/** POST /chat — send a message and stream the response. */
app.post('/chat', async (c) => {
  const userId = c.get('auth').user.id;
  const body = await c.req.json<{ conversationId?: string; message: string }>();

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

  // Relay the SSE stream from the DO
  if (!response.body) {
    return c.json({ error: 'No response from SAM' }, 500);
  }

  return new Response(response.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
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
  return c.json(data);
});

/** GET /conversations/:id/messages — get messages for a conversation. */
app.get('/conversations/:id/messages', async (c) => {
  const userId = c.get('auth').user.id;
  const conversationId = c.req.param('id');
  const limit = c.req.query('limit') || '';
  const stub = getSamSession(c.env, userId);
  const url = limit
    ? `https://sam-session/conversations/${conversationId}/messages?limit=${encodeURIComponent(limit)}`
    : `https://sam-session/conversations/${conversationId}/messages`;
  const response = await stub.fetch(url);
  const data = await response.json();
  return c.json(data);
});

/** GET /search — full-text search across conversation history. */
app.get('/search', async (c) => {
  const userId = c.get('auth').user.id;
  const query = c.req.query('query') || '';
  const limit = c.req.query('limit') || '';
  if (!query.trim()) {
    return c.json({ error: 'Query parameter is required' }, 400);
  }
  const stub = getSamSession(c.env, userId);
  const params = new URLSearchParams({ query });
  if (limit) params.set('limit', limit);
  const response = await stub.fetch(`https://sam-session/search?${params.toString()}`);
  const data = await response.json();
  return c.json(data);
});

export const samRoutes = app;
