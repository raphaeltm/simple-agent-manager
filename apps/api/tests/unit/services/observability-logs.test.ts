import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queryCloudflareLogs, CfApiError } from '../../../src/services/observability';

// Mock drizzle-orm for schema import
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: vi.fn(),
    select: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  like: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  or: vi.fn(),
  sql: Object.assign((..._args: unknown[]) => '', { raw: vi.fn() }),
}));

describe('queryCloudflareLogs()', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseInput = {
    cfApiToken: 'test-token',
    cfAccountId: 'test-account-id',
    timeRange: {
      start: '2026-02-14T00:00:00Z',
      end: '2026-02-14T23:59:59Z',
    },
  };

  it('should call CF Observability API with correct URL and auth', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { events: [], cursor: null } }),
    });
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs(baseInput);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('test-account-id');
    expect(url).toContain('/workers/observability/telemetry/query');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('should send timeframe with epoch milliseconds', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { events: [], cursor: null } }),
    });
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs(baseInput);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.timeframe).toEqual({
      from: new Date('2026-02-14T00:00:00Z').getTime(),
      to: new Date('2026-02-14T23:59:59Z').getTime(),
    });
    expect(requestBody).not.toHaveProperty('timeRange');
  });

  it('should build filter for levels', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { events: [], cursor: null } }),
    });
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      levels: ['error', 'warn'],
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.filters).toContainEqual({
      key: '$workers.event.level',
      operation: 'in',
      value: ['error', 'warn'],
    });
  });

  it('should build filter for search text', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { events: [], cursor: null } }),
    });
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      search: 'database error',
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.filters).toContainEqual({
      key: '$workers.event.message',
      operation: 'includes',
      value: 'database error',
    });
  });

  it('should pass cursor when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { events: [], cursor: null } }),
    });
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      cursor: 'next-page-token',
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.cursor).toBe('next-page-token');
  });

  it('should enforce max limit of 500', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { events: [], cursor: null } }),
    });
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      limit: 999,
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.limit).toBe(500);
  });

  it('should normalize CF API response to LogQueryResponse', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: {
          events: [
            {
              timestamp: '2026-02-14T12:00:00.000Z',
              event: {
                type: 'http.request',
                level: 'error',
                message: 'Something failed',
                method: 'GET',
                path: '/api/health',
              },
              invocationId: 'inv-123',
            },
          ],
          cursor: 'page-2',
        },
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await queryCloudflareLogs(baseInput);

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].timestamp).toBe('2026-02-14T12:00:00.000Z');
    expect(result.logs[0].level).toBe('error');
    expect(result.logs[0].event).toBe('http.request');
    expect(result.logs[0].message).toBe('Something failed');
    expect(result.logs[0].invocationId).toBe('inv-123');
    expect(result.cursor).toBe('page-2');
  });

  it('should strip sensitive fields from details', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: {
          events: [
            {
              timestamp: '2026-02-14T12:00:00.000Z',
              event: {
                level: 'info',
                message: 'test',
                authorization: 'Bearer secret',
                cookie: 'session=abc',
                safeField: 'keep this',
              },
            },
          ],
          cursor: null,
        },
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await queryCloudflareLogs(baseInput);

    expect(result.logs[0].details).not.toHaveProperty('authorization');
    expect(result.logs[0].details).not.toHaveProperty('cookie');
    expect(result.logs[0].details).toHaveProperty('safeField', 'keep this');
  });

  it('should throw CfApiError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow(CfApiError);
    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow('unreachable');
  });

  it('should throw CfApiError with permission hint on 403 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow(CfApiError);
    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow('Workers Observability (Read)');
  });

  it('should throw CfApiError with token hint on 401 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow(CfApiError);
    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow('invalid or expired');
  });

  it('should throw generic CfApiError with response body on other error status codes', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal server error'),
    });

    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow(CfApiError);
    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow('500: internal server error');
  });

  it('should throw CfApiError on invalid JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('parse error')),
    });

    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow(CfApiError);
    await expect(queryCloudflareLogs(baseInput)).rejects.toThrow('Invalid response');
  });

  it('should return hasMore=true when cursor is present and logs fill limit', async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      timestamp: `2026-02-14T${String(i).padStart(2, '0')}:00:00.000Z`,
      event: { level: 'info', message: `log ${i}` },
    }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: { events, cursor: 'next-page' },
      }),
    });

    const result = await queryCloudflareLogs(baseInput);

    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('next-page');
  });

  it('should return empty logs when CF returns no events', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { events: [] } }),
    });

    const result = await queryCloudflareLogs(baseInput);

    expect(result.logs).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });
});


