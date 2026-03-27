import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { analyticsMiddleware } from '../../src/middleware/analytics';
import { getEventName, bucketUserAgent } from '../../src/middleware/analytics';

// ---------------------------------------------------------------------------
// Event name mapping tests
// ---------------------------------------------------------------------------

describe('getEventName', () => {
  it('returns mapped name for known routes', () => {
    expect(getEventName('POST', '/api/projects')).toBe('project_created');
    expect(getEventName('POST', '/api/workspaces')).toBe('workspace_created');
    expect(getEventName('POST', '/api/projects/:projectId/tasks')).toBe('task_submitted');
    expect(getEventName('DELETE', '/api/nodes/:id')).toBe('node_deleted');
  });

  it('returns fallback for unknown routes', () => {
    expect(getEventName('GET', '/api/unknown/route')).toBe('GET /api/unknown/route');
    expect(getEventName('POST', '/api/something/custom')).toBe('POST /api/something/custom');
  });
});

// ---------------------------------------------------------------------------
// User-Agent bucketing tests
// ---------------------------------------------------------------------------

describe('bucketUserAgent', () => {
  it('returns unknown for null/undefined', () => {
    expect(bucketUserAgent(null)).toBe('unknown');
    expect(bucketUserAgent(undefined)).toBe('unknown');
    expect(bucketUserAgent('')).toBe('unknown');
  });

  it('detects bots', () => {
    expect(bucketUserAgent('Googlebot/2.1')).toBe('bot');
    expect(bucketUserAgent('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe('bot');
  });

  it('detects Chrome desktop', () => {
    expect(bucketUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
    )).toBe('chrome-desktop');
  });

  it('detects Chrome mobile', () => {
    expect(bucketUserAgent(
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile',
    )).toBe('chrome-mobile');
  });

  it('detects Firefox', () => {
    expect(bucketUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('firefox-desktop');
  });

  it('detects Safari', () => {
    expect(bucketUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    )).toBe('safari-desktop');
  });

  it('detects curl', () => {
    expect(bucketUserAgent('curl/8.4.0')).toBe('curl');
  });

  it('detects Edge', () => {
    expect(bucketUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Edg/120.0',
    )).toBe('edge-desktop');
  });
});

// ---------------------------------------------------------------------------
// Analytics middleware tests
// ---------------------------------------------------------------------------

describe('analyticsMiddleware', () => {
  let mockWriteDataPoint: ReturnType<typeof vi.fn>;
  let mockWaitUntil: ReturnType<typeof vi.fn>;

  function createApp(envOverrides: Record<string, unknown> = {}) {
    mockWriteDataPoint = vi.fn();
    mockWaitUntil = vi.fn((promise: Promise<unknown>) => promise);

    const env = {
      ANALYTICS: { writeDataPoint: mockWriteDataPoint },
      ANALYTICS_ENABLED: 'true',
      ...envOverrides,
    };

    const executionCtx = { waitUntil: mockWaitUntil, passThroughOnException: vi.fn() };

    const app = new Hono();

    app.use('*', analyticsMiddleware());

    app.get('/health', (c) => c.text('ok'));
    app.get('/api/projects', (c) => c.json({ projects: [] }));
    app.post('/api/projects', (_c) => {
      return new Response(JSON.stringify({ id: '123' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    app.get('/api/admin/analytics/dau', (c) => c.json({ dau: [] }));

    // Helper to make requests with env and executionCtx injected
    const makeRequest = (path: string, init?: RequestInit) => {
      const req = new Request(`http://localhost${path}`, init);
      return app.fetch(req, env, executionCtx);
    };

    return { app, makeRequest };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a data point for normal API requests', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest('/api/projects');
    expect(res.status).toBe(200);

    // Wait for waitUntil promises
    await Promise.all(mockWaitUntil.mock.calls.map((c: unknown[]) => c[0]));

    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    const call = mockWriteDataPoint.mock.calls[0][0];
    expect(call.indexes).toEqual(['anonymous']);
    expect(call.blobs[0]).toBeDefined(); // event name
    expect(call.doubles).toHaveLength(3);
    expect(call.doubles[0]).toBeGreaterThanOrEqual(0); // response time
    expect(call.doubles[1]).toBe(200); // status code
    expect(call.doubles[2]).toBe(0); // reserved
  });

  it('skips health check endpoints', async () => {
    const { makeRequest } = createApp();
    await makeRequest('/health');

    await Promise.all(mockWaitUntil.mock.calls.map((c: unknown[]) => c[0]));

    expect(mockWriteDataPoint).not.toHaveBeenCalled();
  });

  it('does not write when analytics is disabled', async () => {
    const { makeRequest } = createApp({ ANALYTICS_ENABLED: 'false' });
    await makeRequest('/api/projects');

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it('does not write when ANALYTICS binding is missing', async () => {
    const { makeRequest } = createApp({ ANALYTICS: undefined });
    await makeRequest('/api/projects');

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it('skips custom skip patterns from env', async () => {
    const { makeRequest } = createApp({ ANALYTICS_SKIP_ROUTES: '/api/admin/analytics' });
    await makeRequest('/api/admin/analytics/dau');

    await Promise.all(mockWaitUntil.mock.calls.map((c: unknown[]) => c[0]));

    expect(mockWriteDataPoint).not.toHaveBeenCalled();
  });

  it('never throws even if writeDataPoint fails', async () => {
    const { makeRequest } = createApp();
    mockWriteDataPoint.mockImplementation(() => {
      throw new Error('Analytics Engine down');
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await makeRequest('/api/projects');
    expect(res.status).toBe(200);

    await Promise.all(mockWaitUntil.mock.calls.map((c: unknown[]) => c[0]));

    // Should have logged a warning, not thrown
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('records correct status code for POST creating a resource', async () => {
    const { makeRequest } = createApp();
    const res = await makeRequest('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(201);

    await Promise.all(mockWaitUntil.mock.calls.map((c: unknown[]) => c[0]));

    const call = mockWriteDataPoint.mock.calls[0][0];
    expect(call.doubles[1]).toBe(201);
  });
});
