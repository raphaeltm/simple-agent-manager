import { Hono } from 'hono';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { analyticsIngestRoutes } from '../../src/routes/analytics-ingest';

/**
 * Integration tests for the host field in analytics ingest.
 *
 * These tests exercise the actual POST /api/t route handler to verify:
 * - Client-provided host is stored in blob2
 * - Server-derived host from Origin/Referer is used as fallback
 * - Client host takes precedence over server-derived host
 * - ANALYTICS_INGEST_ENABLED=false returns 204 without writing
 */

// Mock auth middleware
vi.mock('../../src/middleware/auth', () => ({
  optionalAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../src/middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimit: () => 500,
}));

describe('analytics ingest — host field via route handler', () => {
  let mockWriteDataPoint: ReturnType<typeof vi.fn>;

  function createApp(envOverrides: Record<string, unknown> = {}) {
    const app = new Hono();

    app.use('*', async (c, next) => {
      (c.env as Record<string, unknown>) = {
        ANALYTICS: { writeDataPoint: mockWriteDataPoint },
        ...envOverrides,
      };
      await next();
    });

    app.route('/api/t', analyticsIngestRoutes);
    return app;
  }

  beforeEach(() => {
    mockWriteDataPoint = vi.fn();
  });

  // Allow the fire-and-forget writeAll() promise to settle
  async function flush() {
    await new Promise((r) => setTimeout(r, 10));
  }

  it('stores client-provided host in blob2', async () => {
    const app = createApp();
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          event: 'page_view',
          page: '/blog/post-1',
          host: 'www.simple-agent-manager.org',
        }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();

    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    const args = mockWriteDataPoint.mock.calls[0][0];
    expect(args.blobs[1]).toBe('www.simple-agent-manager.org');
  });

  it('derives host from Origin header when client host is empty', async () => {
    const app = createApp();
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.example.com',
      },
      body: JSON.stringify({
        events: [{
          event: 'page_view',
          page: '/',
        }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();

    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    const args = mockWriteDataPoint.mock.calls[0][0];
    expect(args.blobs[1]).toBe('www.example.com');
  });

  it('derives host from Referer header when Origin is absent', async () => {
    const app = createApp();
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://docs.example.com/guide',
      },
      body: JSON.stringify({
        events: [{
          event: 'page_view',
          page: '/docs/overview',
        }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();

    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    const args = mockWriteDataPoint.mock.calls[0][0];
    expect(args.blobs[1]).toBe('docs.example.com');
  });

  it('server-derived Origin takes precedence over client host (security)', async () => {
    const app = createApp();
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.origin-host.com',
      },
      body: JSON.stringify({
        events: [{
          event: 'page_view',
          page: '/',
          host: 'www.client-host.com',
        }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();

    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    const args = mockWriteDataPoint.mock.calls[0][0];
    // Server-derived host from Origin header is more trustworthy than client-provided
    expect(args.blobs[1]).toBe('www.origin-host.com');
  });

  it('falls back to client host when no Origin/Referer header', async () => {
    const app = createApp();
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          event: 'page_view',
          page: '/',
          host: 'www.fallback-host.com',
        }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();

    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    const args = mockWriteDataPoint.mock.calls[0][0];
    expect(args.blobs[1]).toBe('www.fallback-host.com');
  });

  it('blob2 is empty when no host or Origin/Referer provided', async () => {
    const app = createApp();
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          event: 'page_view',
          page: '/',
        }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();

    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    const args = mockWriteDataPoint.mock.calls[0][0];
    expect(args.blobs[1]).toBe('');
  });

  it('returns 204 without writing when ANALYTICS_INGEST_ENABLED=false', async () => {
    const app = createApp({ ANALYTICS_INGEST_ENABLED: 'false' });
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{ event: 'page_view', page: '/' }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();
    expect(mockWriteDataPoint).not.toHaveBeenCalled();
  });

  it('returns 204 without writing when ANALYTICS binding is missing', async () => {
    const app = createApp({ ANALYTICS: undefined });
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{ event: 'page_view', page: '/' }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();
    expect(mockWriteDataPoint).not.toHaveBeenCalled();
  });

  it('rejects batch exceeding MAX_ANALYTICS_INGEST_BATCH_SIZE', async () => {
    const app = createApp({ MAX_ANALYTICS_INGEST_BATCH_SIZE: '2' });
    // Mount error handler like the main app does
    app.onError((err, c) => {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: err.message }, status as 400);
    });
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          { event: 'page_view', page: '/a' },
          { event: 'page_view', page: '/b' },
          { event: 'page_view', page: '/c' },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Batch too large');
  });

  it('correctly stores all blob fields including host', async () => {
    const app = createApp();
    const res = await app.request('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          event: 'page_view',
          page: '/blog/post-1',
          referrer: 'https://google.com',
          host: 'www.sam.org',
          utmSource: 'twitter',
          utmMedium: 'social',
          utmCampaign: 'launch',
          sessionId: 'sess-123',
          entityId: 'ent-456',
        }],
      }),
    });

    expect(res.status).toBe(204);
    await flush();

    const args = mockWriteDataPoint.mock.calls[0][0];
    expect(args.blobs[0]).toBe('page_view');     // blob1: event
    expect(args.blobs[1]).toBe('www.sam.org');    // blob2: host
    expect(args.blobs[2]).toBe('/blog/post-1');   // blob3: page
    expect(args.blobs[3]).toBe('https://google.com'); // blob4: referrer
    expect(args.blobs[4]).toBe('twitter');        // blob5: utmSource
    expect(args.blobs[5]).toBe('social');         // blob6: utmMedium
    expect(args.blobs[6]).toBe('launch');         // blob7: utmCampaign
    expect(args.blobs[7]).toBe('sess-123');       // blob8: sessionId
  });
});
