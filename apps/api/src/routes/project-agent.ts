/**
 * Project Agent API routes.
 *
 * POST /chat — send a message to the project agent, get SSE stream back
 * GET /conversations — list project agent conversations
 * GET /conversations/:id/messages — get conversation history
 * GET /search — full-text search across conversation history
 *
 * Mounted at /api/projects/:projectId/agent
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';

const app = new Hono<{ Bindings: Env }>();

/** Get the ProjectAgent DO stub for a given projectId. */
function getProjectAgent(env: Env, projectId: string): DurableObjectStub {
  const id = env.PROJECT_AGENT.idFromName(projectId);
  return env.PROJECT_AGENT.get(id);
}

/** POST /chat — send a message and stream the response. */
app.post('/chat', requireAuth(), async (c) => {
  const auth = c.get('auth');
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const body = await c.req.json<{ conversationId?: string; message: string }>();

  if (!body.message?.trim()) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const stub = getProjectAgent(c.env, projectId);
  const response = await stub.fetch('https://project-agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: body.conversationId,
      message: body.message,
      userId: auth.user.id,
      projectId,
    }),
  });

  if (!response.body) {
    return c.json({ error: 'No response from project agent' }, 500);
  }

  return new Response(response.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
});

/** GET /conversations — list conversations. */
app.get('/conversations', requireAuth(), async (c) => {
  const auth = c.get('auth');
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const stub = getProjectAgent(c.env, projectId);
  const response = await stub.fetch('https://project-agent/conversations');
  const data = await response.json();
  return c.json(data);
});

/** GET /conversations/:id/messages — get messages for a conversation. */
app.get('/conversations/:id/messages', requireAuth(), async (c) => {
  const auth = c.get('auth');
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const conversationId = c.req.param('id');
  const limit = c.req.query('limit') || '';
  const stub = getProjectAgent(c.env, projectId);
  const url = limit
    ? `https://project-agent/conversations/${conversationId}/messages?limit=${encodeURIComponent(limit)}`
    : `https://project-agent/conversations/${conversationId}/messages`;
  const response = await stub.fetch(url);
  const data = await response.json();
  return c.json(data);
});

/** GET /search — full-text search across conversation history. */
app.get('/search', requireAuth(), async (c) => {
  const auth = c.get('auth');
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('Missing projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const query = c.req.query('query') || '';
  const limit = c.req.query('limit') || '';
  if (!query.trim()) {
    return c.json({ error: 'Query parameter is required' }, 400);
  }
  const stub = getProjectAgent(c.env, projectId);
  const params = new URLSearchParams({ query });
  if (limit) params.set('limit', limit);
  const response = await stub.fetch(`https://project-agent/search?${params.toString()}`);
  const data = await response.json();
  return c.json(data);
});

export const projectAgentRoutes = app;
