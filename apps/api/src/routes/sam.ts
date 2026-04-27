/**
 * SAM chat API routes.
 *
 * POST /chat — send a message to SAM, get SSE stream back
 * GET /conversations — list user's conversations
 * GET /conversations/:id/messages — get conversation history
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

/** GET /debug — diagnostic env check. */
app.get('/debug', async (c) => {
  const userId = c.get('auth').user.id;
  const stub = getSamSession(c.env, userId);
  const response = await stub.fetch('https://sam-session/debug');
  const data = await response.json();
  return c.json(data);
});

/** GET /ping — diagnostic SSE test. */
app.get('/ping', async (c) => {
  const userId = c.get('auth').user.id;
  const stub = getSamSession(c.env, userId);
  const response = await stub.fetch('https://sam-session/ping');
  if (!response.body) {
    return c.json({ error: 'No response' }, 500);
  }
  return new Response(response.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
});

/** GET /conversations — list conversations. */
app.get('/conversations', async (c) => {
  const userId = c.get('auth').user.id;
  const stub = getSamSession(c.env, userId);
  const response = await stub.fetch('https://sam-session/conversations');
  const data = await response.json();
  return c.json(data);
});

/** GET /conversations/:id/messages — get messages for a conversation. */
app.get('/conversations/:id/messages', async (c) => {
  const userId = c.get('auth').user.id;
  const conversationId = c.req.param('id');
  const stub = getSamSession(c.env, userId);
  const response = await stub.fetch(`https://sam-session/conversations/${conversationId}/messages`);
  const data = await response.json();
  return c.json(data);
});

export const samRoutes = app;
