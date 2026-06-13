import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, TailWorkerEvent } from '../../src';

/**
 * Unit tests for the Tail Worker handler.
 *
 * Tests the `tail()` function with mock `TraceItem[]` data.
 * NOTE: tail_consumers cannot be tested with Miniflare — we test
 * the handler directly with mock data.
 */

// Import the default export
const handler = (await import('../../src/index')).default;

type MockFetcher = { fetch: ReturnType<typeof vi.fn> };
type TestEnv = Omit<Env, 'API_WORKER'> & { API_WORKER?: MockFetcher };

interface TraceLogFixture {
  level: string;
  message: unknown;
  timestamp: unknown;
}

interface TraceItemFixture {
  scriptName: string;
  logs?: TraceLogFixture[];
  exceptions: [];
  event: null;
  eventTimestamp: unknown;
  outcome: 'ok';
}

describe('Tail Worker handler', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    env = {
      API_WORKER: { fetch: mockFetch },
    };
  });

  function createTraceItem(overrides: Partial<TraceItemFixture> = {}): TraceItem {
    return {
      scriptName: 'workspaces-api',
      logs: [],
      exceptions: [],
      event: null,
      eventTimestamp: Date.now(),
      outcome: 'ok',
      ...overrides,
    } as TraceItem;
  }

  function createLogItem(
    level: string,
    message: unknown,
    timestamp: unknown = Date.now()
  ): TraceLogFixture {
    return {
      level,
      message: Array.isArray(message) ? message : [message],
      timestamp,
    };
  }

  function forwardedLogs(): TailWorkerEvent[] {
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      logs: TailWorkerEvent[];
    };
    return body.logs;
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

    await handler.tail(events, env as Env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const logs = forwardedLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].entry.level).toBe('error');
    expect(logs[1].entry.level).toBe('info'); // 'log' maps to 'info'
  });

  it('should skip debug and trace level logs', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('debug', 'Debug message'), createLogItem('error', 'Error message')],
      }),
    ];

    await handler.tail(events, env as Env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const logs = forwardedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].entry.level).toBe('error');
  });

  it('should not forward when no log entries found', async () => {
    const events = [createTraceItem({ logs: [] })];

    await handler.tail(events, env as Env);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not forward when events have no logs', async () => {
    const events = [createTraceItem({ logs: undefined })];

    await handler.tail(events, env as Env);

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

    await handler.tail(events, env as Env);

    const logs = forwardedLogs();
    expect(logs[0].entry.event).toBe('http.request');
    expect(logs[0].entry.message).toBe('GET /api/health');
    expect(logs[0].entry.details).toHaveProperty('method', 'GET');
  });

  it('should handle non-JSON log messages gracefully', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('error', 'Plain text error message')],
      }),
    ];

    await handler.tail(events, env as Env);

    const logs = forwardedLogs();
    expect(logs[0].entry.message).toBe('Plain text error message');
    expect(logs[0].entry.event).toBe('log');
  });

  it('should include script name in log entries', async () => {
    const events = [
      createTraceItem({
        scriptName: 'my-worker',
        logs: [createLogItem('info', 'test')],
      }),
    ];

    await handler.tail(events, env as Env);

    const logs = forwardedLogs();
    expect(logs[0].entry.scriptName).toBe('my-worker');
  });

  it('should handle missing API_WORKER binding gracefully', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('error', 'test error')],
      }),
    ];

    // No API_WORKER binding
    await handler.tail(events, {});

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
    await handler.tail(events, env as Env);

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should map console.warn to warn level', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('warn', 'Warning message')],
      }),
    ];

    await handler.tail(events, env as Env);

    const logs = forwardedLogs();
    expect(logs[0].entry.level).toBe('warn');
  });

  it('should forward to the correct internal URL', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('info', 'test')],
      }),
    ];

    await handler.tail(events, env as Env);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('https://internal/api/admin/observability/logs/ingest');
  });

  it('should send correct Content-Type header', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('info', 'test')],
      }),
    ];

    await handler.tail(events, env as Env);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should handle multiple trace items', async () => {
    const events = [
      createTraceItem({
        logs: [createLogItem('info', 'request 1')],
      }),
      createTraceItem({
        logs: [createLogItem('error', 'error 1'), createLogItem('warn', 'warning 1')],
      }),
    ];

    await handler.tail(events, env as Env);

    const logs = forwardedLogs();
    expect(logs).toHaveLength(3);
  });

  it('does not throw on invalid log timestamps and falls back to the trace timestamp', async () => {
    const fallbackTimestamp = '2026-06-13T12:34:56.789Z';
    const throwingTimestamp = {
      valueOf() {
        throw new Error('cannot convert timestamp');
      },
    };
    const events = [
      createTraceItem({
        eventTimestamp: Date.parse(fallbackTimestamp),
        logs: [
          createLogItem('error', 'bad timestamp', 'not-a-date'),
          createLogItem('warn', 'throwing timestamp', throwingTimestamp),
        ],
      }),
    ];

    await expect(handler.tail(events, env as Env)).resolves.toBeUndefined();

    const logs = forwardedLogs();
    expect(logs[0].entry.timestamp).toBe(fallbackTimestamp);
    expect(logs[1].entry.timestamp).toBe(fallbackTimestamp);
    expect(Number.isNaN(Date.parse(logs[0].entry.timestamp))).toBe(false);
  });

  it('does not throw on malformed message shapes and forwards a safe string message', async () => {
    const unstringifiableMessage = {
      toString() {
        throw new Error('cannot stringify');
      },
    };
    const events = [
      createTraceItem({
        logs: [{ level: 'warn', message: unstringifiableMessage, timestamp: Date.now() }],
      }),
    ];

    await expect(handler.tail(events, env as Env)).resolves.toBeUndefined();

    const logs = forwardedLogs();
    expect(logs[0].entry.level).toBe('warn');
    expect(logs[0].entry.message).toBe('');
    expect(logs[0].entry.event).toBe('log');
  });

  it('does not allow structured JSON to forward a debug level after console-level filtering', async () => {
    const structuredMessage = JSON.stringify({
      level: 'debug',
      event: 'tail.structured',
      message: 'structured log',
    });
    const events = [
      createTraceItem({
        logs: [createLogItem('log', structuredMessage)],
      }),
    ];

    await handler.tail(events, env as Env);

    const logs = forwardedLogs();
    expect(logs[0].entry.level).toBe('info');
    expect(['error', 'warn', 'info']).toContain(logs[0].entry.level);
  });

  it('uses only non-empty string structured message and event fields', async () => {
    const structuredMessage = JSON.stringify({
      level: { nested: 'warn' },
      event: 123,
      message: { text: 'not a string' },
      code: 'bad_shape',
    });
    const events = [
      createTraceItem({
        logs: [createLogItem('info', structuredMessage)],
      }),
    ];

    await handler.tail(events, env as Env);

    const logs = forwardedLogs();
    expect(logs[0].entry.level).toBe('info');
    expect(logs[0].entry.event).toBe('log');
    expect(logs[0].entry.message).toBe(structuredMessage);
    expect(typeof logs[0].entry.event).toBe('string');
    expect(typeof logs[0].entry.message).toBe('string');
    expect(logs[0].entry.details).toHaveProperty('code', 'bad_shape');
  });
});
