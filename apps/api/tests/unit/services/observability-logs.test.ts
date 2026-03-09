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

  /** Helper: build a CF API response with the new events structure */
  function cfResponse(events: Array<Record<string, unknown>> = [], cursor: string | null = null) {
    return {
      ok: true,
      json: () => Promise.resolve({
        result: {
          events: { events },
          run: cursor ? { offset: cursor } : {},
        },
      }),
    };
  }

  /** Helper: build a legacy CF API response (events as a flat array) */
  function legacyCfResponse(events: Array<Record<string, unknown>> = [], cursor: string | null = null) {
    return {
      ok: true,
      json: () => Promise.resolve({
        result: { events, cursor },
      }),
    };
  }

  it('should call CF Observability API with correct URL and auth', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
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

  it('should include a queryId string in the request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs(baseInput);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.queryId).toBeDefined();
    expect(typeof requestBody.queryId).toBe('string');
    expect(requestBody.queryId.length).toBeGreaterThan(0);
  });

  it('should generate a unique queryId per request when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs(baseInput);
    await queryCloudflareLogs(baseInput);

    const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body1.queryId).not.toBe(body2.queryId);
  });

  it('should use caller-supplied queryId when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      queryId: 'my-custom-query-id',
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.queryId).toBe('my-custom-query-id');
  });

  it('should return queryId in the response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    const result = await queryCloudflareLogs(baseInput);

    expect(result.queryId).toBeDefined();
    expect(typeof result.queryId).toBe('string');
    expect(result.queryId.length).toBeGreaterThan(0);
  });

  it('should return the same queryId in the response when caller-supplied', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    const result = await queryCloudflareLogs({
      ...baseInput,
      queryId: 'pagination-query-id',
    });

    expect(result.queryId).toBe('pagination-query-id');
  });

  it('should send timeframe with epoch milliseconds', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs(baseInput);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.timeframe).toEqual({
      from: new Date('2026-02-14T00:00:00Z').getTime(),
      to: new Date('2026-02-14T23:59:59Z').getTime(),
    });
    expect(requestBody).not.toHaveProperty('timeRange');
  });

  it('should send view=events at top level', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs(baseInput);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.view).toBe('events');
  });

  it('should nest filters inside parameters object with type field', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      levels: ['error', 'warn'],
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Filters should be inside parameters, not at top level
    expect(requestBody.parameters).toBeDefined();
    expect(requestBody.parameters.filters).toContainEqual({
      key: '$workers.event.level',
      operation: 'in',
      type: 'string',
      value: ['error', 'warn'],
    });
    // Should NOT have filters at top level
    expect(requestBody).not.toHaveProperty('filters');
  });

  it('should use needle for search text instead of filter', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      search: 'database error',
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.parameters.needle).toEqual({
      value: 'database error',
      isRegex: false,
      matchCase: false,
    });
  });

  it('should include datasets and orderBy in parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs(baseInput);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.parameters.datasets).toEqual([]);
    expect(requestBody.parameters.orderBy).toEqual({
      value: 'timestamp',
      order: 'desc',
    });
  });

  it('should pass cursor as offset when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      cursor: 'next-page-token',
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.offset).toBe('next-page-token');
  });

  it('should enforce max limit of 500', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      limit: 999,
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.limit).toBe(500);
  });

  it('should normalize CF API response with $metadata format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: {
          events: {
            events: [
              {
                $metadata: {
                  id: 'evt-1',
                  level: 'error',
                  message: 'Something failed',
                  type: 'http.request',
                  requestId: 'req-123',
                },
                $workers: {
                  scriptName: 'my-worker',
                  requestId: 'req-123',
                  eventType: 'fetch',
                  outcome: 'exception',
                  event: {
                    method: 'GET',
                    path: '/api/health',
                  },
                },
                timestamp: 1707912000000,
                dataset: 'workers',
                source: 'worker',
              },
            ],
          },
          run: { offset: 'page-2' },
        },
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await queryCloudflareLogs(baseInput);

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].timestamp).toBe(new Date(1707912000000).toISOString());
    expect(result.logs[0].level).toBe('error');
    expect(result.logs[0].event).toBe('http.request');
    expect(result.logs[0].message).toBe('Something failed');
    expect(result.logs[0].invocationId).toBe('req-123');
    expect(result.cursor).toBe('page-2');
  });

  it('should handle legacy CF API response format (flat events array)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(legacyCfResponse(
      [
        {
          timestamp: '2026-02-14T12:00:00.000Z',
          event: {
            type: 'http.request',
            level: 'error',
            message: 'Legacy format',
            method: 'GET',
          },
          invocationId: 'inv-legacy',
        },
      ],
      'legacy-cursor',
    ));
    globalThis.fetch = mockFetch;

    const result = await queryCloudflareLogs(baseInput);

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].message).toBe('Legacy format');
    expect(result.logs[0].level).toBe('error');
    expect(result.cursor).toBe('legacy-cursor');
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
    globalThis.fetch = vi.fn().mockResolvedValue(cfResponse());

    const result = await queryCloudflareLogs(baseInput);

    expect(result.logs).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  // Regression test: this test verifies the fix for the "Query not found" error.
  // The old code sent filters, orderBy, and limit at the top level of the request body,
  // which caused the CF API to interpret queryId as a saved query reference.
  // With the fix, these fields are nested inside a `parameters` object, and
  // `view: 'events'` is set at top level, making it a valid ad-hoc query.
  it('should structure request body correctly to avoid "Query not found" error', async () => {
    const mockFetch = vi.fn().mockResolvedValue(cfResponse());
    globalThis.fetch = mockFetch;

    await queryCloudflareLogs({
      ...baseInput,
      levels: ['error'],
      search: 'test search',
    });

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);

    // Top-level required fields
    expect(requestBody).toHaveProperty('queryId');
    expect(requestBody).toHaveProperty('timeframe');
    expect(requestBody).toHaveProperty('view', 'events');
    expect(requestBody).toHaveProperty('parameters');

    // Parameters structure
    expect(requestBody.parameters).toHaveProperty('datasets');
    expect(requestBody.parameters).toHaveProperty('filters');
    expect(requestBody.parameters).toHaveProperty('orderBy');
    expect(requestBody.parameters).toHaveProperty('needle');

    // Filters must include type field (CF API requirement)
    for (const filter of requestBody.parameters.filters) {
      expect(filter).toHaveProperty('type');
    }

    // orderBy must be an object, not a string
    expect(typeof requestBody.parameters.orderBy).toBe('object');
    expect(requestBody.parameters.orderBy).toHaveProperty('value');
    expect(requestBody.parameters.orderBy).toHaveProperty('order');

    // These should NOT be at the top level
    expect(requestBody).not.toHaveProperty('filters');
    expect(requestBody).not.toHaveProperty('orderBy');
    expect(requestBody).not.toHaveProperty('order');
  });

  it('should convert numeric timestamps to ISO strings in response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: {
          events: {
            events: [
              {
                $metadata: { id: 'e1', level: 'info', message: 'test' },
                timestamp: 1707912000000,
                dataset: 'workers',
                source: 'worker',
              },
            ],
          },
          run: {},
        },
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await queryCloudflareLogs(baseInput);

    expect(result.logs[0].timestamp).toBe(new Date(1707912000000).toISOString());
  });
});
