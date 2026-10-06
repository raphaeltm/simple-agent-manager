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
 *   - invalid `sessionId` → 400, DO never called
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
const addPushSubscription = vi.fn().mockResolvedValue({
  endpoint: 'https://push.example.test/subscription',
  userAgent: 'Test Browser',
  disabledAt: null,
  failureCount: 0,
  lastSuccessAt: null,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
});
const removePushSubscription = vi.fn().mockResolvedValue(true);
const listPushSubscriptions = vi.fn().mockResolvedValue([]);

const mockEnv = {
  KV: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  },
  NOTIFICATION: {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
    get: vi.fn().mockReturnValue({
      listNotifications,
      addPushSubscription,
      removePushSubscription,
      listPushSubscriptions,
    }),
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
    ['sessionId=bad/id', 'invalid sessionId'],
    ['sessionId=', 'empty sessionId'],
  ])('returns 400 for invalid %s (%s) without calling the DO', async (qs) => {
    const app = buildApp();
    const res = await app.request(`/notifications?${qs}`, {}, mockEnv);
    expect(res.status).toBe(400);
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it('passes valid query parameters through to the DO', async () => {
    const app = buildApp();
    const res = await app.request(
      '/notifications?cursor=1700000000000&limit=10&filter=unread&type=error&projectId=proj-9&sessionId=session-9',
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
        sessionId: 'session-9',
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

describe('Web Push subscription routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates and stores a browser subscription with its user agent', async () => {
    const app = buildApp();
    const subscription = {
      endpoint: 'https://push.example.test/subscription',
      expirationTime: null,
      keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
    };
    const response = await app.request(
      '/notifications/push/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Test Browser' },
        body: JSON.stringify(subscription),
      },
      mockEnv
    );

    expect(response.status).toBe(201);
    expect(addPushSubscription).toHaveBeenCalledWith('user-123', subscription, 'Test Browser');
  });

  it('rejects non-HTTPS subscription endpoints before the DO call', async () => {
    const app = buildApp();
    const response = await app.request(
      '/notifications/push/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'http://push.example.test/subscription',
          keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
        }),
      },
      mockEnv
    );

    expect(response.status).toBe(400);
    expect(addPushSubscription).not.toHaveBeenCalled();
  });

  it('lists subscription metadata without key material', async () => {
    const app = buildApp();
    const response = await app.request('/notifications/push/subscriptions', {}, mockEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subscriptions: [] });
    expect(listPushSubscriptions).toHaveBeenCalledWith('user-123');
  });

  it('removes only the submitted endpoint', async () => {
    const app = buildApp();
    const endpoint = 'https://push.example.test/subscription';
    const response = await app.request(
      '/notifications/push/subscriptions',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      },
      mockEnv
    );

    expect(response.status).toBe(200);
    expect(removePushSubscription).toHaveBeenCalledWith('user-123', endpoint);
  });
});
