import { Hono } from 'hono';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { analyticsIngestRoutes } from '../../../src/routes/analytics-ingest';

// Mock auth middleware — skip auth for unit tests
vi.mock('../../../src/middleware/auth', () => ({
  optionalAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Mock rate limit middleware — skip for unit tests
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimit: () => 500,
}));

describe('analytics-ingest routes', () => {
  let mockWriteDataPoint: ReturnType<typeof vi.fn>;
  let mockWaitUntil: ReturnType<typeof vi.fn>;

  function createApp(envOverrides: Record<string, unknown> = {}) {
    mockWriteDataPoint = vi.fn();
    mockWaitUntil = vi.fn((promise: Promise<unknown>) => promise);

    const env = {
      ANALYTICS: { writeDataPoint: mockWriteDataPoint },
      ...envOverrides,
    };

    const executionCtx = { waitUntil: mockWaitUntil, passThroughOnException: vi.fn() };

    const app = new Hono();

    // Add error handler to match production behavior
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    app.route('/api/t', analyticsIngestRoutes);

    const makeRequest = (init?: RequestInit) => {
      const req = new Request('http://localhost/api/t', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      return app.fetch(req, env, executionCtx);
    };

    return { app, makeRequest, env, executionCtx };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 204 for valid batch of events', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest({
      body: JSON.stringify({
        events: [
          { event: 'page_view', page: '/dashboard', sessionId: 'sess-123' },
          { event: 'ui_click', page: '/settings', entityId: 'save-btn' },
        ],
      }),
    });

    expect(res.status).toBe(204);
    await mockWaitUntil.mock.calls[0][0];
    expect(mockWriteDataPoint).toHaveBeenCalledTimes(2);
  });

  it('writes correct Analytics Engine schema fields', async () => {
    const { makeRequest } = createApp();
    await makeRequest({
      body: JSON.stringify({
        events: [
          {
            event: 'page_view',
            page: '/projects/abc',
            referrer: 'https://google.com',
            utmSource: 'twitter',
            utmMedium: 'social',
            utmCampaign: 'launch',
            sessionId: 'sess-456',
            visitorId: 'visitor-789',
            entityId: 'proj-abc',
            durationMs: 1500,
          },
        ],
      }),
    });

    await mockWaitUntil.mock.calls[0][0];

    expect(mockWriteDataPoint).toHaveBeenCalledWith({
      indexes: ['anon-unknown'],  // unauthenticated: server-side IP fallback (visitorId ignored)
      blobs: [
        'page_view',        // blob1: event name
        '',                 // blob2: projectId (empty for client events)
        '/projects/abc',    // blob3: page
        'https://google.com', // blob4: referrer
        'twitter',          // blob5: utm_source
        'social',           // blob6: utm_medium
        'launch',           // blob7: utm_campaign
        'sess-456',         // blob8: session ID
        expect.any(String), // blob9: user-agent bucket (server-derived)
        '',                 // blob10: country
        'proj-abc',         // blob11: entity ID
      ],
      doubles: [
        1500,               // double1: duration
        0,                  // double2: status code (N/A)
        0,                  // double3: reserved
      ],
    });
  });

  it('returns 204 for empty events array', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest({
      body: JSON.stringify({ events: [] }),
    });

    expect(res.status).toBe(204);
    expect(mockWriteDataPoint).not.toHaveBeenCalled();
  });

  it('drops malformed events silently', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest({
      body: JSON.stringify({
        events: [
          null,
          { noEventField: true },
          { event: '' },
          { event: 'valid_event', page: '/ok' },
          42,
        ],
      }),
    });

    expect(res.status).toBe(204);
    await mockWaitUntil.mock.calls[0][0];
    // Only the one valid event should be written
    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    expect(mockWriteDataPoint.mock.calls[0][0].blobs[0]).toBe('valid_event');
  });

  it('rejects batch exceeding max size', async () => {
    const { makeRequest } = createApp({ MAX_ANALYTICS_INGEST_BATCH_SIZE: '3' });
    const res = await makeRequest({
      body: JSON.stringify({
        events: [
          { event: 'e1' },
          { event: 'e2' },
          { event: 'e3' },
          { event: 'e4' },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('max 3');
  });

  it('rejects invalid JSON body', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest({
      body: 'not json',
    });

    expect(res.status).toBe(400);
  });

  it('rejects body without events array', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest({
      body: JSON.stringify({ data: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('events');
  });

  it('returns 204 when ingest is disabled', async () => {
    const { makeRequest } = createApp({ ANALYTICS_INGEST_ENABLED: 'false' });
    const res = await makeRequest({
      body: JSON.stringify({ events: [{ event: 'test' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockWriteDataPoint).not.toHaveBeenCalled();
  });

  it('returns 204 when ANALYTICS binding is missing', async () => {
    const { makeRequest } = createApp({ ANALYTICS: undefined });
    const res = await makeRequest({
      body: JSON.stringify({ events: [{ event: 'test' }] }),
    });

    expect(res.status).toBe(204);
  });

  it('truncates long string fields within budget', async () => {
    const { makeRequest } = createApp();
    const longEvent = 'x'.repeat(200);
    await makeRequest({
      body: JSON.stringify({
        events: [{ event: longEvent, page: '/ok' }],
      }),
    });

    await mockWaitUntil.mock.calls[0][0];
    const writtenBlobs = mockWriteDataPoint.mock.calls[0][0].blobs;
    // Event name should be truncated to exactly 128 chars (125 chars + '...')
    expect(writtenBlobs[0].length).toBe(128);
    expect(writtenBlobs[0]).toContain('...');
  });

  it('uses anon-IP fallback when both userId and visitorId are absent', async () => {
    const { makeRequest } = createApp();
    await makeRequest({
      body: JSON.stringify({
        events: [{ event: 'anon_event', page: '/landing' }],
      }),
    });

    await mockWaitUntil.mock.calls[0][0];
    const index = mockWriteDataPoint.mock.calls[0][0].indexes[0];
    expect(index).toMatch(/^anon-/);
  });

  it('rejects when events field is not an array', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest({
      body: JSON.stringify({ events: 'not-an-array' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('array');
  });

  it('rejects negative durationMs values', async () => {
    const { makeRequest } = createApp();
    await makeRequest({
      body: JSON.stringify({
        events: [{ event: 'test', durationMs: -500 }],
      }),
    });

    await mockWaitUntil.mock.calls[0][0];
    const writtenDoubles = mockWriteDataPoint.mock.calls[0][0].doubles;
    expect(writtenDoubles[0]).toBe(0); // clamped to 0
  });

  it('clamps durationMs to upper bound (1 hour)', async () => {
    const { makeRequest } = createApp();
    await makeRequest({
      body: JSON.stringify({
        events: [{ event: 'test', durationMs: 9_999_999 }],
      }),
    });

    await mockWaitUntil.mock.calls[0][0];
    const writtenDoubles = mockWriteDataPoint.mock.calls[0][0].doubles;
    expect(writtenDoubles[0]).toBe(3_600_000); // clamped to 1 hour
  });

  it('ignores client-provided visitorId for unauthenticated requests', async () => {
    const { makeRequest } = createApp();
    await makeRequest({
      body: JSON.stringify({
        events: [{ event: 'test', visitorId: 'spoofed-id' }],
      }),
    });

    await mockWaitUntil.mock.calls[0][0];
    const index = mockWriteDataPoint.mock.calls[0][0].indexes[0];
    expect(index).toMatch(/^anon-/); // server-side IP, not client visitorId
    expect(index).not.toBe('spoofed-id');
  });

  it('handles Analytics Engine write failure gracefully', async () => {
    const failingWrite = vi.fn(() => { throw new Error('AE unavailable'); });
    const { makeRequest } = createApp({ ANALYTICS: { writeDataPoint: failingWrite } });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await makeRequest({
      body: JSON.stringify({ events: [{ event: 'test' }] }),
    });

    expect(res.status).toBe(204);
    await mockWaitUntil.mock.calls[0][0];
    // Logger emits a single JSON string to console.warn
    expect(consoleSpy).toHaveBeenCalled();
    const warnEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(warnEntry.event).toBe('analytics_ingest.write_failed');
    expect(warnEntry.error).toContain('AE unavailable');
    consoleSpy.mockRestore();
  });
});
