import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the Tail Worker's subscriber-aware forwarding gate.
 *
 * These tests exercise the module-global subscriber cache, so each test
 * re-imports the handler with a fresh module registry (`vi.resetModules()`)
 * to isolate cache state.
 */

function createTraceItem(level = 'info', message = 'test') {
  return {
    scriptName: 'workspaces-api',
    logs: [{ level, message: [message], timestamp: Date.now() }],
    exceptions: [],
    event: null,
    eventTimestamp: Date.now(),
    outcome: 'ok',
  };
}

async function loadHandler() {
  vi.resetModules();
  return (await import('../../src/index')).default;
}

function ingestResponse(subscribers: number) {
  return new Response(JSON.stringify({ ok: true, subscribers }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Tail Worker subscriber-aware gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('consumes the ingest response body (reads subscribers count)', async () => {
    const handler = await loadHandler();
    const response = ingestResponse(2);
    const jsonSpy = vi.spyOn(response, 'json');
    const mockFetch = vi.fn().mockResolvedValue(response);

    await handler.tail([createTraceItem()] as any, { API_WORKER: { fetch: mockFetch } } as any);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledTimes(1);
  });

  it('skips forwarding when last observed subscriber count is zero (cache fresh)', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' } as any;

    // First call forwards and caches subscribers=0
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call within TTL must skip forwarding
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps forwarding when subscribers are present', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(3));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' } as any;

    await handler.tail([createTraceItem()] as any, env);
    await handler.tail([createTraceItem()] as any, env);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('re-probes (forwards again) after the cache TTL expires', async () => {
    vi.useFakeTimers();
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '5000' } as any;

    // Forward and cache subscribers=0
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Within TTL: skipped
    vi.advanceTimersByTime(4000);
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // After TTL: re-probes
    vi.advanceTimersByTime(2000);
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('resumes forwarding once a subscriber connects (count > 0 after re-probe)', async () => {
    vi.useFakeTimers();
    const handler = await loadHandler();
    let subscribers = 0;
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(ingestResponse(subscribers)));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '5000' } as any;

    // Cache subscribers=0
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Admin connects; after TTL the re-probe observes subscribers=1
    subscribers = 1;
    vi.advanceTimersByTime(6000);
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Now forwarding continues without waiting for TTL
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not gate when the response body is not JSON (count stays unknown)', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' } as any;

    await handler.tail([createTraceItem()] as any, env);
    await handler.tail([createTraceItem()] as any, env);

    // Unknown count never gates forwarding off
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('forwards the parsed log entries to the ingest endpoint', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(1));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' } as any;

    await handler.tail([createTraceItem('error', 'boom')] as any, env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/admin/observability/logs/ingest');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].entry.level).toBe('error');
    expect(body.logs[0].entry.message).toBe('boom');
  });

  it('fails open: a DO fetch error never re-arms the zero-count gate (cache ts not refreshed)', async () => {
    vi.useFakeTimers();
    const handler = await loadHandler();
    let mode: 'zero' | 'throw' = 'zero';
    const mockFetch = vi.fn().mockImplementation(() => {
      if (mode === 'throw') return Promise.reject(new Error('DO unreachable'));
      return Promise.resolve(ingestResponse(0));
    });
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '5000' } as any;

    // Cache subscribers=0 (gate armed)
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // After TTL, the DO is unreachable. The re-probe throws and is swallowed —
    // crucially it must NOT refresh subscriberCache.ts, otherwise a flapping DO
    // would extend the gate-closed window indefinitely.
    mode = 'throw';
    vi.advanceTimersByTime(6000);
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // The cache ts was not refreshed by the failed probe, so the very next
    // invocation still attempts to forward (fail-open) rather than being gated.
    await handler.tail([createTraceItem()] as any, env);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not corrupt the cache when the ingest endpoint returns a non-2xx body', async () => {
    const handler = await loadHandler();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' } as any;

    // 500 has no subscribers field → count stays unknown → never gates off
    await handler.tail([createTraceItem()] as any, env);
    await handler.tail([createTraceItem()] as any, env);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('applies the gate using the default TTL when TAIL_SUBSCRIBER_CACHE_MS is unset', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env = { API_WORKER: { fetch: mockFetch } } as any; // no TAIL_SUBSCRIBER_CACHE_MS

    // First call caches subscribers=0; second (well within the 5s default) skips
    await handler.tail([createTraceItem()] as any, env);
    await handler.tail([createTraceItem()] as any, env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("disables the gate when TAIL_SUBSCRIBER_CACHE_MS is '0' (always forwards)", async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '0' } as any;

    // TTL of 0 means the cache is never fresh, so zero-count never gates off
    await handler.tail([createTraceItem()] as any, env);
    await handler.tail([createTraceItem()] as any, env);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
