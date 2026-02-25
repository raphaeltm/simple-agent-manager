import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../src/index';

// Mock auth middleware
const mockGetUserId = vi.fn().mockReturnValue('user-superadmin');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  requireSuperadmin: () => vi.fn((_c: any, next: any) => next()),
  getUserId: (...args: unknown[]) => mockGetUserId(...args),
}));

// Mock error middleware
vi.mock('../../../src/middleware/error', () => {
  class AppError extends Error {
    statusCode: number;
    error: string;
    constructor(statusCode: number, error: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.error = error;
    }
  }
  return {
    errors: {
      badRequest: (msg: string) => new AppError(400, 'BAD_REQUEST', msg),
      notFound: (entity: string) => new AppError(404, 'NOT_FOUND', `${entity} not found`),
      forbidden: (msg: string) => new AppError(403, 'FORBIDDEN', msg),
    },
    AppError,
  };
});

// Mock observability service
const mockQueryErrors = vi.fn();
const mockGetHealthSummary = vi.fn();
const mockGetErrorTrends = vi.fn();
const mockQueryCloudflareLogs = vi.fn();
const mockCheckRateLimit = vi.fn().mockReturnValue({ allowed: true, remaining: 29, resetMs: 60000 });

class MockCfApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfApiError';
  }
}

vi.mock('../../../src/services/observability', () => ({
  queryErrors: (...args: unknown[]) => mockQueryErrors(...args),
  getHealthSummary: (...args: unknown[]) => mockGetHealthSummary(...args),
  getErrorTrends: (...args: unknown[]) => mockGetErrorTrends(...args),
  queryCloudflareLogs: (...args: unknown[]) => mockQueryCloudflareLogs(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  CfApiError: MockCfApiError,
}));

// We need to import after mocks are set up
const { adminRoutes } = await import('../../../src/routes/admin');

describe('Admin Observability Routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();

    app = new Hono<{ Bindings: Env }>();

    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    app.route('/api/admin', adminRoutes);
  });

  function createEnv(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: {} as D1Database,
      OBSERVABILITY_DATABASE: {} as D1Database,
      ...overrides,
    } as Env;
  }

  // ===========================================================================
  // GET /api/admin/observability/errors
  // ===========================================================================
  describe('GET /api/admin/observability/errors', () => {
    it('should return 200 with error list from queryErrors service', async () => {
      const mockResult = {
        errors: [
          {
            id: 'err-1',
            source: 'client',
            level: 'error',
            message: 'Test error',
            stack: null,
            context: null,
            userId: null,
            nodeId: null,
            workspaceId: null,
            ipAddress: null,
            userAgent: null,
            timestamp: '2026-02-14T12:00:00.000Z',
          },
        ],
        cursor: null,
        hasMore: false,
        total: 1,
      };
      mockQueryErrors.mockResolvedValue(mockResult);

      const res = await app.request('/api/admin/observability/errors', {}, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].source).toBe('client');
      expect(body.total).toBe(1);
    });

    it('should pass filter params to queryErrors', async () => {
      mockQueryErrors.mockResolvedValue({ errors: [], cursor: null, hasMore: false, total: 0 });

      await app.request(
        '/api/admin/observability/errors?source=vm-agent&level=warn&search=test&limit=10',
        {},
        createEnv()
      );

      expect(mockQueryErrors).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          source: 'vm-agent',
          level: 'warn',
          search: 'test',
          limit: 10,
        })
      );
    });

    it('should pass time range params to queryErrors', async () => {
      mockQueryErrors.mockResolvedValue({ errors: [], cursor: null, hasMore: false, total: 0 });

      const startTime = '2026-02-14T00:00:00Z';
      const endTime = '2026-02-14T23:59:59Z';

      await app.request(
        `/api/admin/observability/errors?startTime=${startTime}&endTime=${endTime}`,
        {},
        createEnv()
      );

      expect(mockQueryErrors).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          startTime: new Date(startTime).getTime(),
          endTime: new Date(endTime).getTime(),
        })
      );
    });

    it('should pass cursor param to queryErrors', async () => {
      mockQueryErrors.mockResolvedValue({ errors: [], cursor: null, hasMore: false, total: 0 });

      await app.request(
        '/api/admin/observability/errors?cursor=abc123',
        {},
        createEnv()
      );

      expect(mockQueryErrors).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          cursor: 'abc123',
        })
      );
    });

    it('should treat source=all as no source filter', async () => {
      mockQueryErrors.mockResolvedValue({ errors: [], cursor: null, hasMore: false, total: 0 });

      await app.request('/api/admin/observability/errors?source=all', {}, createEnv());

      expect(mockQueryErrors).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          source: undefined,
        })
      );
    });

    it('should treat level=all as no level filter', async () => {
      mockQueryErrors.mockResolvedValue({ errors: [], cursor: null, hasMore: false, total: 0 });

      await app.request('/api/admin/observability/errors?level=all', {}, createEnv());

      expect(mockQueryErrors).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          level: undefined,
        })
      );
    });

    it('should return 400 for invalid source', async () => {
      const res = await app.request(
        '/api/admin/observability/errors?source=invalid',
        {},
        createEnv()
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid source');
    });

    it('should return 400 for invalid level', async () => {
      const res = await app.request(
        '/api/admin/observability/errors?level=critical',
        {},
        createEnv()
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid level');
    });

    it('should return 400 for invalid limit', async () => {
      const res = await app.request(
        '/api/admin/observability/errors?limit=999',
        {},
        createEnv()
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('limit must be between');
    });

    it('should return 400 for non-numeric limit', async () => {
      const res = await app.request(
        '/api/admin/observability/errors?limit=abc',
        {},
        createEnv()
      );

      expect(res.status).toBe(400);
    });

    it('should return empty result when OBSERVABILITY_DATABASE is not set', async () => {
      const res = await app.request(
        '/api/admin/observability/errors',
        {},
        createEnv({ OBSERVABILITY_DATABASE: undefined as unknown as D1Database })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toEqual([]);
      expect(body.total).toBe(0);
      expect(mockQueryErrors).not.toHaveBeenCalled();
    });

    it('should return paginated results', async () => {
      mockQueryErrors.mockResolvedValue({
        errors: Array.from({ length: 50 }, (_, i) => ({
          id: `err-${i}`,
          source: 'api',
          level: 'error',
          message: `Error ${i}`,
          stack: null,
          context: null,
          userId: null,
          nodeId: null,
          workspaceId: null,
          ipAddress: null,
          userAgent: null,
          timestamp: '2026-02-14T12:00:00.000Z',
        })),
        cursor: 'next-cursor',
        hasMore: true,
        total: 100,
      });

      const res = await app.request('/api/admin/observability/errors', {}, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toHaveLength(50);
      expect(body.cursor).toBe('next-cursor');
      expect(body.hasMore).toBe(true);
      expect(body.total).toBe(100);
    });
  });

  // ===========================================================================
  // GET /api/admin/observability/health
  // ===========================================================================
  describe('GET /api/admin/observability/health', () => {
    it('should return health summary from getHealthSummary service', async () => {
      const mockHealth = {
        activeNodes: 3,
        activeWorkspaces: 5,
        inProgressTasks: 2,
        errorCount24h: 42,
        timestamp: '2026-02-14T12:00:00.000Z',
      };
      mockGetHealthSummary.mockResolvedValue(mockHealth);

      const res = await app.request('/api/admin/observability/health', {}, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.activeNodes).toBe(3);
      expect(body.errorCount24h).toBe(42);
    });

    it('should return zero values when OBSERVABILITY_DATABASE is not set', async () => {
      const res = await app.request(
        '/api/admin/observability/health',
        {},
        createEnv({ OBSERVABILITY_DATABASE: undefined as unknown as D1Database })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.activeNodes).toBe(0);
      expect(body.errorCount24h).toBe(0);
      expect(mockGetHealthSummary).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET /api/admin/observability/trends
  // ===========================================================================
  describe('GET /api/admin/observability/trends', () => {
    it('should return trends from getErrorTrends service', async () => {
      const mockTrends = {
        range: '24h',
        interval: '1h',
        buckets: [
          { timestamp: '2026-02-14T00:00:00.000Z', total: 5, bySource: { client: 2, 'vm-agent': 1, api: 2 } },
        ],
      };
      mockGetErrorTrends.mockResolvedValue(mockTrends);

      const res = await app.request('/api/admin/observability/trends', {}, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.range).toBe('24h');
      expect(body.buckets).toHaveLength(1);
    });

    it('should pass range query param', async () => {
      mockGetErrorTrends.mockResolvedValue({ range: '7d', interval: '1d', buckets: [] });

      await app.request('/api/admin/observability/trends?range=7d', {}, createEnv());

      expect(mockGetErrorTrends).toHaveBeenCalledWith(expect.anything(), '7d');
    });

    it('should return 400 for invalid range', async () => {
      const res = await app.request(
        '/api/admin/observability/trends?range=2w',
        {},
        createEnv()
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid range');
    });

    it('should return empty buckets when OBSERVABILITY_DATABASE is not set', async () => {
      const res = await app.request(
        '/api/admin/observability/trends',
        {},
        createEnv({ OBSERVABILITY_DATABASE: undefined as unknown as D1Database })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.buckets).toEqual([]);
      expect(mockGetErrorTrends).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /api/admin/observability/logs/query
  // ===========================================================================
  describe('POST /api/admin/observability/logs/query', () => {
    const validBody = {
      timeRange: {
        start: '2026-02-14T00:00:00Z',
        end: '2026-02-14T23:59:59Z',
      },
    };

    function postLogs(body: unknown, envOverrides: Partial<Env> = {}) {
      return app.request('/api/admin/observability/logs/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, createEnv({
        CF_API_TOKEN: 'test-token',
        CF_ACCOUNT_ID: 'test-account',
        ...envOverrides,
      }));
    }

    it('should return 200 with log results from queryCloudflareLogs', async () => {
      const mockResult = {
        logs: [{ timestamp: '2026-02-14T12:00:00Z', level: 'info', event: 'http.request', message: 'GET /health', details: {}, invocationId: 'inv-1' }],
        cursor: null,
        hasMore: false,
      };
      mockQueryCloudflareLogs.mockResolvedValue(mockResult);

      const res = await postLogs(validBody);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.logs).toHaveLength(1);
      expect(body.logs[0].message).toBe('GET /health');
    });

    it('should pass timeRange, levels, search, limit, cursor to service', async () => {
      mockQueryCloudflareLogs.mockResolvedValue({ logs: [], cursor: null, hasMore: false });

      await postLogs({
        timeRange: { start: '2026-02-14T00:00:00Z', end: '2026-02-14T12:00:00Z' },
        levels: ['error', 'warn'],
        search: 'timeout',
        limit: 50,
        cursor: 'page-2',
      });

      expect(mockQueryCloudflareLogs).toHaveBeenCalledWith(expect.objectContaining({
        cfApiToken: 'test-token',
        cfAccountId: 'test-account',
        timeRange: { start: '2026-02-14T00:00:00Z', end: '2026-02-14T12:00:00Z' },
        levels: ['error', 'warn'],
        search: 'timeout',
        limit: 50,
        cursor: 'page-2',
      }));
    });

    it('should return 400 when CF credentials are not configured', async () => {
      const res = await postLogs(validBody, {
        CF_API_TOKEN: undefined as unknown as string,
        CF_ACCOUNT_ID: undefined as unknown as string,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('credentials');
    });

    it('should return 400 when timeRange is missing', async () => {
      const res = await postLogs({});

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('timeRange');
    });

    it('should return 400 when timeRange dates are invalid', async () => {
      const res = await postLogs({
        timeRange: { start: 'not-a-date', end: 'also-not' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('ISO 8601');
    });

    it('should return 400 for invalid level in levels array', async () => {
      const res = await postLogs({
        ...validBody,
        levels: ['error', 'critical'],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid level');
    });

    it('should return 400 when levels is not an array', async () => {
      const res = await postLogs({
        ...validBody,
        levels: 'error',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('array');
    });

    it('should return 400 for invalid limit', async () => {
      const res = await postLogs({
        ...validBody,
        limit: 999,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('limit');
    });

    it('should return 429 when rate limited', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 30000 });

      const res = await postLogs(validBody);

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe('RATE_LIMITED');
    });

    it('should include rate limit headers', async () => {
      mockQueryCloudflareLogs.mockResolvedValue({ logs: [], cursor: null, hasMore: false });

      const res = await postLogs(validBody);

      expect(res.headers.get('X-RateLimit-Remaining')).toBe('29');
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('should return 502 when CF API fails', async () => {
      mockQueryCloudflareLogs.mockRejectedValue(new MockCfApiError('Cloudflare API returned 500'));

      const res = await postLogs(validBody);

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe('CF_API_ERROR');
    });
  });

  // ===========================================================================
  // GET /api/admin/observability/logs/stream (WebSocket upgrade)
  // ===========================================================================
  describe('GET /api/admin/observability/logs/stream', () => {
    it('should return 400 when Upgrade header is missing', async () => {
      const mockDoStub = { fetch: vi.fn() };
      const mockIdFromName = vi.fn().mockReturnValue('do-id');
      const mockGet = vi.fn().mockReturnValue(mockDoStub);

      const res = await app.request('/api/admin/observability/logs/stream', {}, createEnv({
        ADMIN_LOGS: { idFromName: mockIdFromName, get: mockGet } as unknown as DurableObjectNamespace,
      }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('WebSocket upgrade required');
      expect(mockDoStub.fetch).not.toHaveBeenCalled();
    });

    it('should forward WebSocket upgrade to AdminLogs DO', async () => {
      // In the Cloudflare runtime, the DO returns status 101 for WebSocket upgrades.
      // In Node.js, Response rejects status 101. Use status 200 as a stand-in
      // and verify the DO stub was called correctly.
      const mockDoResponse = new Response(null, { status: 200 });
      const mockDoStub = { fetch: vi.fn().mockResolvedValue(mockDoResponse) };
      const mockIdFromName = vi.fn().mockReturnValue('do-id');
      const mockGet = vi.fn().mockReturnValue(mockDoStub);

      await app.request('/api/admin/observability/logs/stream', {
        headers: { Upgrade: 'websocket' },
      }, createEnv({
        ADMIN_LOGS: { idFromName: mockIdFromName, get: mockGet } as unknown as DurableObjectNamespace,
      }));

      expect(mockIdFromName).toHaveBeenCalledWith('admin-logs');
      expect(mockGet).toHaveBeenCalledWith('do-id');
      expect(mockDoStub.fetch).toHaveBeenCalledTimes(1);

      // Verify the DO receives a request with /ws path
      const doRequest = mockDoStub.fetch.mock.calls[0][0] as Request;
      expect(new URL(doRequest.url).pathname).toBe('/ws');
    });
  });

  // ===========================================================================
  // POST /api/admin/observability/logs/ingest (Tail Worker ingestion)
  // ===========================================================================
  describe('POST /api/admin/observability/logs/ingest', () => {
    it('should forward log entries to AdminLogs DO', async () => {
      const mockDoResponse = new Response('OK', { status: 200 });
      const mockDoStub = { fetch: vi.fn().mockResolvedValue(mockDoResponse) };
      const mockIdFromName = vi.fn().mockReturnValue('do-id');
      const mockGet = vi.fn().mockReturnValue(mockDoStub);

      const logs = [{
        type: 'log',
        entry: {
          timestamp: '2026-02-14T12:00:00Z',
          level: 'info',
          event: 'test',
          message: 'test log',
          details: {},
          scriptName: 'test-worker',
        },
      }];

      const res = await app.request('/api/admin/observability/logs/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs }),
      }, createEnv({
        ADMIN_LOGS: { idFromName: mockIdFromName, get: mockGet } as unknown as DurableObjectNamespace,
      }));

      expect(res.status).toBe(200);
      expect(mockIdFromName).toHaveBeenCalledWith('admin-logs');
      expect(mockDoStub.fetch).toHaveBeenCalledTimes(1);

      // Verify the DO receives a request with /ingest path
      const doRequest = mockDoStub.fetch.mock.calls[0][0] as Request;
      expect(new URL(doRequest.url).pathname).toBe('/ingest');
    });
  });
});
