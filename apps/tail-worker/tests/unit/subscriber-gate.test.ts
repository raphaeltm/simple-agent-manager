import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src';

/**
 * Unit tests for the Tail Worker's subscriber-aware forwarding gate.
 *
 * These tests exercise the module-global subscriber cache, so each test
 * re-imports the handler with a fresh module registry (`vi.resetModules()`)
 * to isolate cache state.
 */

type MockFetcher = { fetch: ReturnType<typeof vi.fn> };
type TestEnv = Omit<Env, 'API_WORKER'> & { API_WORKER: MockFetcher };

function createTraceItem(level = 'info', message = 'test'): TraceItem {
  return {
    scriptName: 'workspaces-api',
    logs: [{ level, message: [message], timestamp: Date.now() }],
    exceptions: [],
    event: null,
    eventTimestamp: Date.now(),
    outcome: 'ok',
  } as TraceItem;
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

    await handler.tail([createTraceItem()], { API_WORKER: { fetch: mockFetch } } as TestEnv);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledTimes(1);
  });

  it('skips forwarding when last observed subscriber count is zero (cache fresh)', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    // First call forwards and caches subscribers=0
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call within TTL must skip forwarding
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps forwarding when subscribers are present', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(3));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('re-probes (forwards again) after the cache TTL expires', async () => {
    vi.useFakeTimers();
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '5000' };

    // Forward and cache subscribers=0
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Within TTL: skipped
    vi.advanceTimersByTime(4000);
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // After TTL: re-probes
    vi.advanceTimersByTime(2000);
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('resumes forwarding once a subscriber connects (count > 0 after re-probe)', async () => {
    vi.useFakeTimers();
    const handler = await loadHandler();
    let subscribers = 0;
    const mockFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(ingestResponse(subscribers)));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '5000' };

    // Cache subscribers=0
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Admin connects; after TTL the re-probe observes subscribers=1
    subscribers = 1;
    vi.advanceTimersByTime(6000);
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Now forwarding continues without waiting for TTL
    await handler.tail([createTraceItem()], env);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('fails to zero when the response body has no subscriber count', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('forwards the parsed log entries to the ingest endpoint', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(1));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    await handler.tail([createTraceItem('error', 'boom')], env);

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

  it('fails to zero when the DO fetch rejects', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockRejectedValue(new Error('DO unreachable'));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails to zero when the ingest endpoint returns a non-2xx body', async () => {
    const handler = await loadHandler();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails to zero when a non-2xx ingest response contains subscribers=0 JSON', async () => {
    const handler = await loadHandler();
    const response = new Response(JSON.stringify({ ok: false, subscribers: 0 }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
    const jsonSpy = vi.spyOn(response, 'json');
    const mockFetch = vi.fn().mockResolvedValue(response);
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails to zero for malformed subscriber counts on successful ingest responses', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ subscribers: -1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '60000' };

    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('applies the gate using the default TTL when TAIL_SUBSCRIBER_CACHE_MS is unset', async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch } }; // no TAIL_SUBSCRIBER_CACHE_MS

    // First call caches subscribers=0; second (well within the 5s default) skips
    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("disables the gate when TAIL_SUBSCRIBER_CACHE_MS is '0' (always forwards)", async () => {
    const handler = await loadHandler();
    const mockFetch = vi.fn().mockResolvedValue(ingestResponse(0));
    const env: TestEnv = { API_WORKER: { fetch: mockFetch }, TAIL_SUBSCRIBER_CACHE_MS: '0' };

    // TTL of 0 means the cache is never fresh, so zero-count never gates off
    await handler.tail([createTraceItem()], env);
    await handler.tail([createTraceItem()], env);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
