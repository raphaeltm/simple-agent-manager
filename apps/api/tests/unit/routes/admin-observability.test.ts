import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  diagnosticSecretCanaries,
  expectDiagnosticCanariesAbsent,
} from '../../helpers/diagnostic-secret-canaries';

// Mock auth middleware
const mockGetUserId = vi.fn().mockReturnValue('user-superadmin');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  requireSuperadmin: () =>
    vi.fn((c: any, next: any) => {
      if (c.req.header('x-test-role') === 'non-superadmin')
        return c.json({ error: 'FORBIDDEN' }, 403);
      return next();
    }),
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

const mockCreateDebugDiagnosisRun = vi.fn();
const mockGetDebugDiagnosisRun = vi.fn();
const mockStartDiagnosisRunner = vi.fn();
const mockCancelDiagnosisRunner = vi.fn();
const mockListDiagnosisEvents = vi.fn();
const mockRetryDebugDiagnosisRun = vi.fn();
const mockListDebugDiagnoses = vi.fn();
const mockSaveDebugDiagnosisAsIdea = vi.fn();
vi.mock('../../../src/services/debug-agent', () => ({
  createDebugDiagnosisRun: (...args: unknown[]) => mockCreateDebugDiagnosisRun(...args),
  getDebugDiagnosisRun: (...args: unknown[]) => mockGetDebugDiagnosisRun(...args),
  retryDebugDiagnosisRun: (...args: unknown[]) => mockRetryDebugDiagnosisRun(...args),
  listDebugDiagnoses: (...args: unknown[]) => mockListDebugDiagnoses(...args),
  saveDebugDiagnosisAsIdea: (...args: unknown[]) => mockSaveDebugDiagnosisAsIdea(...args),
}));
vi.mock('../../../src/services/diagnosis-runner', () => ({
  startDiagnosisRunner: (...args: unknown[]) => mockStartDiagnosisRunner(...args),
  cancelDiagnosisRunner: (...args: unknown[]) => mockCancelDiagnosisRunner(...args),
  listDiagnosisEvents: (...args: unknown[]) => mockListDiagnosisEvents(...args),
}));
const mockRunPlatformFeedbackTriage = vi.fn();
vi.mock('../../../src/services/platform-feedback-triage', () => ({
  runPlatformFeedbackTriage: (...args: unknown[]) => mockRunPlatformFeedbackTriage(...args),
}));

// Mock observability service
const mockQueryErrors = vi.fn();
const mockGetHealthSummary = vi.fn();
const mockGetErrorTrends = vi.fn();
const mockQueryCloudflareLogs = vi.fn();

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
  getLogQueryRateLimit: () => 30,
  CfApiError: MockCfApiError,
}));

const mockGetDiagnosticIncidentsByErrorIds = vi.fn().mockResolvedValue(new Map());
const mockGetDiagnosticIncidentByErrorId = vi.fn();
const mockGetDiagnosticArtifactForDownload = vi.fn();
vi.mock('../../../src/services/diagnostic-incidents', () => ({
  getDiagnosticIncidentsByErrorIds: (...args: unknown[]) =>
    mockGetDiagnosticIncidentsByErrorIds(...args),
  getDiagnosticIncidentByErrorId: (...args: unknown[]) =>
    mockGetDiagnosticIncidentByErrorId(...args),
  getDiagnosticArtifactForDownload: (...args: unknown[]) =>
    mockGetDiagnosticArtifactForDownload(...args),
}));

// Mock rate-limit middleware (allow all by default)
const mockRateLimitMiddleware = vi.fn((_c: any, next: any) => next());
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => mockRateLimitMiddleware,
}));

// We need to import after mocks are set up
const { adminRoutes } = await import('../../../src/routes/admin');
const { observabilityIngestRoutes } = await import('../../../src/routes/observability-ingest');

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

    app.route('/api/admin/observability/logs/ingest', observabilityIngestRoutes);
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
      expect(mockGetDiagnosticIncidentsByErrorIds).toHaveBeenCalledWith(expect.anything(), [
        'err-1',
      ]);
    });

    it('batch-decorates errors with incident summaries without per-row reads', async () => {
      const incident = {
        id: 'incident-1',
        platformErrorId: 'err-1',
        status: 'pending',
        artifacts: [],
      };
      mockQueryErrors.mockResolvedValue({
        errors: [
          {
            id: 'err-1',
            source: 'vm-agent',
            level: 'error',
            message: 'failed',
            timestamp: '2026-08-05T12:00:00.000Z',
          },
          {
            id: 'err-2',
            source: 'api',
            level: 'error',
            message: 'other',
            timestamp: '2026-08-05T12:00:00.000Z',
          },
        ],
        cursor: null,
        hasMore: false,
        total: 2,
      });
      mockGetDiagnosticIncidentsByErrorIds.mockResolvedValue(new Map([['err-1', incident]]));

      const res = await app.request('/api/admin/observability/errors', {}, createEnv());
      expect(res.status).toBe(200);
      expect((await res.json()).errors).toEqual([
        expect.objectContaining({ id: 'err-1', incident }),
        expect.objectContaining({ id: 'err-2', incident: null }),
      ]);
      expect(mockGetDiagnosticIncidentsByErrorIds).toHaveBeenCalledTimes(1);
      expect(mockGetDiagnosticIncidentByErrorId).not.toHaveBeenCalled();
    });

    it('rejects non-superadmins before incident summary or download reads', async () => {
      const headers = { 'x-test-role': 'non-superadmin' };
      const summary = await app.request(
        '/api/admin/observability/errors/err-1/incident',
        { headers },
        createEnv()
      );
      const download = await app.request(
        '/api/admin/observability/errors/err-1/incident/artifacts/art-1/download',
        { headers },
        createEnv()
      );
      expect(summary.status).toBe(403);
      expect(download.status).toBe(403);
      expect(mockGetDiagnosticIncidentByErrorId).not.toHaveBeenCalled();
      expect(mockGetDiagnosticArtifactForDownload).not.toHaveBeenCalled();
    });

    it('returns the sanitized incident contract without any shared canary in the admin response', async () => {
      mockGetDiagnosticIncidentByErrorId.mockResolvedValue({
        id: 'incident-safe',
        platformErrorId: 'err-1',
        status: 'available',
        preview: {
          health: 'degraded',
          values: diagnosticSecretCanaries.map(() => '[REDACTED]'),
        },
        artifacts: [],
      });

      const res = await app.request(
        '/api/admin/observability/errors/err-1/incident',
        {},
        createEnv()
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('[REDACTED]');
      expectDiagnosticCanariesAbsent(body);
    });

    it('streams an available artifact through the private no-store admin proxy', async () => {
      const safeArchive = JSON.stringify({
        values: diagnosticSecretCanaries.map(() => '[REDACTED]'),
      });
      mockGetDiagnosticArtifactForDownload.mockResolvedValue({
        row: {
          id: 'art-1',
          incident_id: 'incident-1',
          content_type: 'application/gzip',
          actual_bytes: 4,
        },
        object: {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(safeArchive));
              controller.close();
            },
          }),
        },
      });
      const res = await app.request(
        '/api/admin/observability/errors/err-1/incident/artifacts/art-1/download',
        {},
        createEnv()
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('content-type')).toBe('application/gzip');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="art-1.tar.gz"');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await res.text();
      expect(body).toBe(safeArchive);
      expectDiagnosticCanariesAbsent(body);
      expect(mockGetDiagnosticArtifactForDownload).toHaveBeenCalledWith(
        expect.anything(),
        'err-1',
        'art-1'
      );
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

      await app.request('/api/admin/observability/errors?cursor=abc123', {}, createEnv());

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
      const res = await app.request('/api/admin/observability/errors?limit=999', {}, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('limit must be between');
    });

    it('should return 400 for non-numeric limit', async () => {
      const res = await app.request('/api/admin/observability/errors?limit=abc', {}, createEnv());

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
          {
            timestamp: '2026-02-14T00:00:00.000Z',
            total: 5,
            bySource: { client: 2, 'vm-agent': 1, api: 2 },
          },
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
      const res = await app.request('/api/admin/observability/trends?range=2w', {}, createEnv());

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
      return app.request(
        '/api/admin/observability/logs/query',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        createEnv({
          CF_API_TOKEN: 'test-token',
          CF_ACCOUNT_ID: 'test-account',
          ...envOverrides,
        })
      );
    }

    it('should return 200 with log results from queryCloudflareLogs', async () => {
      const mockResult = {
        logs: [
          {
            timestamp: '2026-02-14T12:00:00Z',
            level: 'info',
            event: 'http.request',
            message: 'GET /health',
            details: {},
            invocationId: 'inv-1',
          },
        ],
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

      expect(mockQueryCloudflareLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          cfApiToken: 'test-token',
          cfAccountId: 'test-account',
          timeRange: { start: '2026-02-14T00:00:00Z', end: '2026-02-14T12:00:00Z' },
          levels: ['error', 'warn'],
          search: 'timeout',
          limit: 50,
          cursor: 'page-2',
        })
      );
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
      expect(body.message).toContain('levels');
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
      // Mock the rate limit middleware to throw a rate limit error
      mockRateLimitMiddleware.mockImplementationOnce(() => {
        const err = new Error('Too many requests. Please try again later.') as Error & {
          statusCode: number;
          error: string;
          retryAfter: number;
        };
        err.statusCode = 429;
        err.error = 'RATE_LIMIT_EXCEEDED';
        err.retryAfter = 30;
        throw err;
      });

      const res = await postLogs(validBody);

      expect(res.status).toBe(429);
    });

    it('should apply rate limit middleware to log query route', async () => {
      mockQueryCloudflareLogs.mockResolvedValue({ logs: [], cursor: null, hasMore: false });

      await postLogs(validBody);

      expect(mockRateLimitMiddleware).toHaveBeenCalled();
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

      const res = await app.request(
        '/api/admin/observability/logs/stream',
        {},
        createEnv({
          ADMIN_LOGS: {
            idFromName: mockIdFromName,
            get: mockGet,
          } as unknown as DurableObjectNamespace,
        })
      );

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

      await app.request(
        '/api/admin/observability/logs/stream',
        {
          headers: { Upgrade: 'websocket' },
        },
        createEnv({
          ADMIN_LOGS: {
            idFromName: mockIdFromName,
            get: mockGet,
          } as unknown as DurableObjectNamespace,
        })
      );

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

      const logs = [
        {
          type: 'log',
          entry: {
            timestamp: '2026-02-14T12:00:00Z',
            level: 'info',
            event: 'test',
            message: 'test log',
            details: {},
            scriptName: 'test-worker',
          },
        },
      ];

      // Use synthetic hostname to simulate service binding call
      const res = await app.request(
        'https://internal/api/admin/observability/logs/ingest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs }),
        },
        createEnv({
          ADMIN_LOGS: {
            idFromName: mockIdFromName,
            get: mockGet,
          } as unknown as DurableObjectNamespace,
        })
      );

      expect(res.status).toBe(200);
      expect(mockIdFromName).toHaveBeenCalledWith('admin-logs');
      expect(mockDoStub.fetch).toHaveBeenCalledTimes(1);

      // Verify the DO receives a request with /ingest path
      const doRequest = mockDoStub.fetch.mock.calls[0][0] as Request;
      expect(new URL(doRequest.url).pathname).toBe('/ingest');
    });
  });

  describe('deployment diagnosis routes', () => {
    it('runs an error-targeted diagnosis as the authenticated superadmin', async () => {
      const diagnosis = {
        id: 'diag-1',
        errorId: 'err-1',
        startTime: '2026-07-29T10:00:00Z',
        endTime: '2026-07-29T10:30:00Z',
        diagnosis: 'Actionable result',
        model: '@cf/zai-org/glm-5.2',
        ideaId: null,
        createdBy: 'user-superadmin',
        createdAt: '2026-07-29T10:31:00Z',
        usage: {
          turns: 2,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          dailyTokensUsed: 120,
          dailyTokenLimit: 120000,
        },
      };
      mockCreateDebugDiagnosisRun.mockResolvedValue(diagnosis);
      const response = await app.request(
        '/api/admin/observability/diagnoses',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ errorId: 'err-1' }),
        },
        createEnv()
      );
      console.log('DEBUG_RESPONSE', await response.clone().json());
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ run: diagnosis });
      expect(mockCreateDebugDiagnosisRun).toHaveBeenCalledWith(
        expect.any(Object),
        'user-superadmin',
        {
          errorId: 'err-1',
        }
      );
    });

    it('returns 429 when the deployment feature budget is exhausted', async () => {
      mockCreateDebugDiagnosisRun.mockRejectedValue(
        new Error('Daily deployment debugging budget exhausted')
      );
      const response = await app.request(
        '/api/admin/observability/diagnoses',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ errorId: 'err-1' }),
        },
        createEnv()
      );
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: 'DEBUG_BUDGET_EXHAUSTED' });
    });

    it('saves a persisted diagnosis as a draft Idea', async () => {
      mockSaveDebugDiagnosisAsIdea.mockResolvedValue({ ideaId: 'idea-1' });
      const response = await app.request(
        '/api/admin/observability/diagnoses/diag-1/idea',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'project-1' }),
        },
        createEnv()
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ideaId: 'idea-1' });
    });
    it('uses the shared manual feedback-triage core from the admin router', async () => {
      const result = {
        enabled: true,
        trigger: 'manual',
        groupsFound: 1,
        ideasCreated: 1,
        ideasUpdated: 0,
        groupsSkipped: 0,
        groupsFailed: 1,
        failureReasons: ['provider rejected [email] token [REDACTED_API_KEY]'],
      };
      mockRunPlatformFeedbackTriage.mockResolvedValue(result);
      const env = createEnv({ PLATFORM_FEEDBACK_PROJECT_ID: 'project-1' });
      const response = await app.request(
        '/api/admin/observability/feedback-triage',
        { method: 'POST' },
        env
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result });
      expect(mockRunPlatformFeedbackTriage).toHaveBeenCalledWith(env, 'manual');
    });
    it('returns sanitized failure accounting from manual feedback triage', async () => {
      const result = {
        enabled: true,
        trigger: 'manual',
        groupsFound: 2,
        ideasCreated: 1,
        ideasUpdated: 0,
        groupsSkipped: 0,
        groupsFailed: 1,
        failureReasons: ['diagnosis failed for [email] using [REDACTED_API_KEY]'],
      };
      mockRunPlatformFeedbackTriage.mockResolvedValue(result);
      const response = await app.request(
        '/api/admin/observability/feedback-triage',
        { method: 'POST' },
        createEnv()
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result });
    });

    it('rejects a non-superadmin before invoking manual triage', async () => {
      const response = await app.request(
        '/api/admin/observability/feedback-triage',
        {
          method: 'POST',
          headers: { 'x-test-role': 'non-superadmin' },
        },
        createEnv({ PLATFORM_FEEDBACK_PROJECT_ID: 'project-1' })
      );
      expect(response.status).toBe(403);
      expect(mockRunPlatformFeedbackTriage).not.toHaveBeenCalled();
    });
  });
});
