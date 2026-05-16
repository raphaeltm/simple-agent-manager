/**
 * Behavioral tests for cross-project chat routes (GET /api/chats/recent, GET /api/chats).
 *
 * Mounts chatsRoutes on a Hono app, mocks auth + D1, and verifies HTTP behavior.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

// Lazy import after mocks are configured
const { chatsRoutes } = await import('../../../src/routes/chats');

/** Helper to build a mock D1 database that returns configurable results. */
function makeMockD1(options: {
  sessionsResults?: unknown[];
  countResult?: { cnt: number };
}) {
  const { sessionsResults = [], countResult = { cnt: 0 } } = options;
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: sessionsResults }),
        first: vi.fn().mockResolvedValue(countResult),
      }),
    }),
  } as unknown as D1Database;
}

describe('chats routes', () => {
  function buildApp(db: D1Database) {
    const a = new Hono<{ Bindings: Env }>();
    a.onError((err, c) => {
      const e = err as { statusCode?: number; message?: string };
      return c.json({ message: e.message }, (e.statusCode ?? 500) as 400 | 500);
    });
    a.route('/api/chats', chatsRoutes);
    return { app: a, env: { DATABASE: db } as unknown as Env };
  }

  const baseSummaryRow = {
    id: 'sess-1',
    project_id: 'proj-1',
    user_id: 'user-1',
    status: 'active',
    topic: 'Test chat',
    task_id: null,
    workspace_id: null,
    message_count: 5,
    started_at: Date.now() - 60_000,
    last_message_at: Date.now() - 30_000,
    agent_completed_at: null,
    ended_at: null,
    updated_at: Date.now(),
    project_name: 'My Project',
  };

  describe('GET /api/chats/recent', () => {
    it('returns sessions and totalActive', async () => {
      const db = makeMockD1({
        sessionsResults: [baseSummaryRow],
        countResult: { cnt: 3 },
      });
      const { app, env } = buildApp(db);

      const res = await app.request('/api/chats/recent', {}, env);
      expect(res.status).toBe(200);

      const body = await res.json<{ sessions: unknown[]; totalActive: number }>();
      expect(body.sessions).toHaveLength(1);
      expect(body.totalActive).toBe(3);

      // Verify camelCase mapping
      const session = body.sessions[0] as Record<string, unknown>;
      expect(session.id).toBe('sess-1');
      expect(session.projectId).toBe('proj-1');
      expect(session.projectName).toBe('My Project');
      expect(session.status).toBe('active');
      expect(session.topic).toBe('Test chat');
      expect(session.messageCount).toBe(5);
    });

    it('returns empty when no sessions', async () => {
      const db = makeMockD1({ sessionsResults: [], countResult: { cnt: 0 } });
      const { app, env } = buildApp(db);

      const res = await app.request('/api/chats/recent', {}, env);
      expect(res.status).toBe(200);

      const body = await res.json<{ sessions: unknown[]; totalActive: number }>();
      expect(body.sessions).toHaveLength(0);
      expect(body.totalActive).toBe(0);
    });

    it('passes limit and staleThreshold params to query', async () => {
      const db = makeMockD1({});
      const { app, env } = buildApp(db);

      await app.request('/api/chats/recent?limit=3&staleThreshold=1800000', {}, env);

      // Verify prepare was called (sessions query + count query)
      expect(db.prepare).toHaveBeenCalledTimes(2);
    });
  });

  describe('GET /api/chats', () => {
    it('returns paginated sessions with total', async () => {
      const db = makeMockD1({
        sessionsResults: [baseSummaryRow],
        countResult: { cnt: 10 },
      });
      const { app, env } = buildApp(db);

      const res = await app.request('/api/chats', {}, env);
      expect(res.status).toBe(200);

      const body = await res.json<{ sessions: unknown[]; total: number }>();
      expect(body.sessions).toHaveLength(1);
      expect(body.total).toBe(10);
    });

    it('handles status filter', async () => {
      const db = makeMockD1({});
      const { app, env } = buildApp(db);

      await app.request('/api/chats?status=stopped', {}, env);

      // Both queries (count + sessions) should be called
      expect(db.prepare).toHaveBeenCalledTimes(2);
    });

    it('handles pagination params', async () => {
      const db = makeMockD1({});
      const { app, env } = buildApp(db);

      await app.request('/api/chats?limit=10&offset=20', {}, env);
      expect(db.prepare).toHaveBeenCalledTimes(2);
    });
  });
});
