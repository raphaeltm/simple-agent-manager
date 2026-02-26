import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the Tail Worker handler.
 *
 * Tests the `tail()` function with mock `TraceItem[]` data.
 * NOTE: tail_consumers cannot be tested with Miniflare — we test
 * the handler directly with mock data.
 */

// Import the default export
const handler = (await import('../../src/index')).default;

describe('Tail Worker handler', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let env: { API_WORKER?: { fetch: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    env = {
      API_WORKER: { fetch: mockFetch },
    };
  });

  function createTraceItem(overrides: Partial<any> = {}): any {
    return {
      scriptName: 'workspaces-api',
      logs: [],
      exceptions: [],
      event: null,
      eventTimestamp: Date.now(),
      outcome: 'ok',
      ...overrides,
    };
  }

  function createLogItem(level: string, message: string, timestamp = Date.now()) {
    return {
      level,
      message: [message],
      timestamp,
    };
  }

  it('should extract log entries from trace items', async () => {
    const events = [
      createTraceItem({
        logs: [
          createLogItem('error', 'Something went wrong'),
          createLogItem('log', 'Normal request'),
        ],
      }),
    ];

    await handler.tail(events, env as any);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0].entry.level).toBe('error');
    expect(body.logs[1].entry.level).toBe('info'); // 'log' maps to 'info'
  });

  it('should skip debug and trace level logs', async () => {
    const events = [
      createTraceItem({
        logs: [
          createLogItem('debug', 'Debug message'),
          createLogItem('error', 'Error message'),
        ],
      }),
    ];

    await handler.tail(events, env as any);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].entry.level).toBe('error');
  });

  it('should not forward when no log entries found', async () => {
    const events = [
      createTraceItem({ logs: [] }),
    ];

    await handler.tail(events, env as any);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not forward when events have no logs', async () => {
    const events = [
      createTraceItem({ logs: undefined }),
    ];

    await handler.tail(events, env as any);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should parse structured JSON log messages', async () => {
    const structuredMessage = JSON.stringify({
      event: 'http.request',
      message: 'GET /api/health',
      method: 'GET',
      path: '/api/health',
      status: 200,
    });

    const events = [
      createTraceItem({
        logs: [createLogItem('log', structuredMessage)],
      }),
    ];

    await handler.tail(events, env as any);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.logs[0].entry.event).toBe('http.request');
    expect(body.logs[0].entry.message).toBe('GET /api/health');
    expect(body.logs[0].entry.details).toHaveProperty('method', 'GET');
  });

  it('should handle non-JSON log messages gracefully', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('error', 'Plain text error message')],
      }),
    ];

    await handler.tail(events, env as any);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.logs[0].entry.message).toBe('Plain text error message');
    expect(body.logs[0].entry.event).toBe('log');
  });

  it('should include script name in log entries', async () => {
    const events = [
      createTraceItem({
        scriptName: 'my-worker',
        logs: [createLogItem('info', 'test')],
      }),
    ];

    await handler.tail(events, env as any);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.logs[0].entry.scriptName).toBe('my-worker');
  });

  it('should handle missing API_WORKER binding gracefully', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('error', 'test error')],
      }),
    ];

    // No API_WORKER binding
    await handler.tail(events, {} as any);

    // Should not throw
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should handle fetch failures gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const events = [
      createTraceItem({
        logs: [createLogItem('error', 'test error')],
      }),
    ];

    // Should not throw
    await handler.tail(events, env as any);

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should map console.warn to warn level', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('warn', 'Warning message')],
      }),
    ];

    await handler.tail(events, env as any);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.logs[0].entry.level).toBe('warn');
  });

  it('should forward to the correct internal URL', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('info', 'test')],
      }),
    ];

    await handler.tail(events, env as any);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('https://internal/api/admin/observability/logs/ingest');
  });

  it('should send correct Content-Type header', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('info', 'test')],
      }),
    ];

    await handler.tail(events, env as any);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should handle multiple trace items', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('info', 'request 1')],
      }),
      createTraceItem({
        logs: [
          createLogItem('error', 'error 1'),
          createLogItem('warn', 'warning 1'),
        ],
      }),
    ];

    await handler.tail(events, env as any);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.logs).toHaveLength(3);
  });
});
