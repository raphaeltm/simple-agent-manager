import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, request } from '../../../src/lib/api/client';

describe('request() — content type handling', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses JSON responses normally', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await request<{ id: number }>('/test');
    expect(result).toEqual({ id: 1 });
  });

  it('throws ApiClientError for non-OK non-JSON responses', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    await expect(request('/test')).rejects.toThrow(ApiClientError);
    await expect(request('/test')).rejects.toThrow('non-JSON error response');
  });

  it('returns empty object for 204 No Content', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await request<void>('/test', { method: 'DELETE' });
    expect(result).toEqual({});
  });

  it('returns empty object when content-type header is missing on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const result = await request<void>('/test');
    expect(result).toEqual({});
  });

  it('throws for unexpected content type like text/html on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(request('/test')).rejects.toThrow(ApiClientError);
    await expect(request('/test')).rejects.toThrow('Expected JSON response');
  });

  it('throws ApiClientError for non-OK JSON responses with code and status', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    try {
      await request('/test');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const e = err as ApiClientError;
      expect(e.code).toBe('NOT_FOUND');
      expect(e.status).toBe(404);
      expect(e.message).toBe('Not found');
    }
  });
});
