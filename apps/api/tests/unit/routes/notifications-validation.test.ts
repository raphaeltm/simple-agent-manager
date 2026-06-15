/**
 * Behavioral tests for query-parameter validation on GET /api/notifications.
 *
 * The route MUST reject malformed query parameters with a 400 *before* the
 * request ever reaches the NotificationService Durable Object. These tests
 * assert that:
 *   - invalid `cursor` (non-integer / non-positive) → 400, DO never called
 *   - invalid `limit` (non-integer / non-positive) → 400, DO never called
 *   - invalid `filter` (not all|unread) → 400, DO never called
 *   - invalid `type` (not a known notification type) → 400, DO never called
 *   - valid parameters pass through to the DO stub
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { notificationRoutes } from '../../../src/routes/notifications';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'user-123',
}));

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/notifications', notificationRoutes);
  return app;
}

const listNotifications = vi.fn().mockResolvedValue({
  notifications: [],
  unreadCount: 0,
  nextCursor: null,
});

const mockEnv = {
  NOTIFICATION: {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
    get: vi.fn().mockReturnValue({ listNotifications }),
  },
} as unknown as Env;

describe('GET /notifications query validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['cursor=abc', 'non-numeric cursor'],
    ['cursor=0', 'zero cursor'],
    ['cursor=-5', 'negative cursor'],
    ['cursor=1.5', 'fractional cursor'],
    ['limit=abc', 'non-numeric limit'],
    ['limit=0', 'zero limit'],
    ['limit=-3', 'negative limit'],
    ['filter=bogus', 'unknown filter'],
    ['type=not_a_type', 'unknown notification type'],
  ])('returns 400 for invalid %s (%s) without calling the DO', async (qs) => {
    const app = buildApp();
    const res = await app.request(`/notifications?${qs}`, {}, mockEnv);
    expect(res.status).toBe(400);
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it('passes valid query parameters through to the DO', async () => {
    const app = buildApp();
    const res = await app.request(
      '/notifications?cursor=1700000000000&limit=10&filter=unread&type=error&projectId=proj-9',
      {},
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(listNotifications).toHaveBeenCalledTimes(1);
    expect(listNotifications).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        cursor: '1700000000000',
        limit: 10,
        filter: 'unread',
        type: 'error',
        projectId: 'proj-9',
      })
    );
  });

  it('allows a request with no query parameters', async () => {
    const app = buildApp();
    const res = await app.request('/notifications', {}, mockEnv);
    expect(res.status).toBe(200);
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });
});
