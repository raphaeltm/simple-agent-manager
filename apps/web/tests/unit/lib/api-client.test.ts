import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, GITHUB_REAUTH_REQUIRED_EVENT, request } from '../../../src/lib/api/client';
import { getProjectRuntimeConfig } from '../../../src/lib/api/projects';

describe('request() — content type handling', () => {
  const originalFetch = globalThis.fetch;
  const mockResponse = (body: BodyInit | null, init: ResponseInit) => {
    vi.mocked(fetch).mockResolvedValue(new Response(body, init));
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('forwards query cancellation through the runtime API wrapper to fetch', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          expect(options?.signal).toBe(controller.signal);
          options?.signal?.addEventListener('abort', () => reject(options.signal!.reason));
        })
    );
    const pending = getProjectRuntimeConfig('project-a', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('parses JSON responses normally', async () => {
    mockResponse(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await request<{ id: number }>('/test');
    expect(result).toEqual({ id: 1 });
  });

  it('throws ApiClientError for non-OK non-JSON responses', async () => {
    mockResponse('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });

    await expect(request('/test')).rejects.toThrow(ApiClientError);
    await expect(request('/test')).rejects.toThrow('non-JSON error response');
  });

  it('returns empty object for 204 No Content', async () => {
    mockResponse(null, { status: 204 });

    const result = await request<void>('/test', { method: 'DELETE' });
    expect(result).toEqual({});
  });

  it('returns empty object when content-type header is missing on success', async () => {
    mockResponse(null, { status: 200 });

    const result = await request<void>('/test');
    expect(result).toEqual({});
  });

  it('throws for unexpected content type like text/html on success', async () => {
    mockResponse('<html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    await expect(request('/test')).rejects.toThrow(ApiClientError);
    await expect(request('/test')).rejects.toThrow('Expected JSON response');
  });

  it('throws ApiClientError for non-OK JSON responses with code and status', async () => {
    mockResponse(JSON.stringify({ error: 'NOT_FOUND', message: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });

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

  it('emits a GitHub reauth event for GITHUB_REAUTH_REQUIRED errors', async () => {
    const onReauth = vi.fn();
    window.addEventListener(GITHUB_REAUTH_REQUIRED_EVENT, onReauth);
    mockResponse(
      JSON.stringify({
        error: 'GITHUB_REAUTH_REQUIRED',
        message: 'Your GitHub authorization has expired — please sign out and back in',
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    await expect(request('/api/projects/proj-1/tasks/submit', { method: 'POST' })).rejects.toThrow(
      ApiClientError
    );

    expect(onReauth).toHaveBeenCalledTimes(1);
    const event = onReauth.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      message: 'Your GitHub authorization has expired — please sign out and back in',
    });
    window.removeEventListener(GITHUB_REAUTH_REQUIRED_EVENT, onReauth);
  });
});
