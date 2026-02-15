import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout, getTimeoutMs } from '../../../src/services/fetch-timeout';

describe('getTimeoutMs', () => {
  it('returns default when env value is undefined', () => {
    expect(getTimeoutMs(undefined, 5000)).toBe(5000);
  });

  it('returns default when env value is empty string', () => {
    expect(getTimeoutMs('', 5000)).toBe(5000);
  });

  it('returns parsed value when env value is valid', () => {
    expect(getTimeoutMs('10000', 5000)).toBe(10000);
  });

  it('returns default when env value is not a number', () => {
    expect(getTimeoutMs('abc', 5000)).toBe(5000);
  });

  it('returns default when env value is zero', () => {
    expect(getTimeoutMs('0', 5000)).toBe(5000);
  });

  it('returns default when env value is negative', () => {
    expect(getTimeoutMs('-100', 5000)).toBe(5000);
  });

  it('uses 30000 as global default when no default provided', () => {
    expect(getTimeoutMs(undefined)).toBe(30_000);
  });
});

describe('fetchWithTimeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns response on successful fetch within timeout', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const response = await fetchWithTimeout('https://example.com', {}, 5000);
    expect(response.status).toBe(200);
  });

  it('passes request init options to fetch', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await fetchWithTimeout(
      'https://example.com',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      5000
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('throws timeout error when fetch exceeds timeout', async () => {
    // Mock fetch that respects AbortSignal
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    await expect(fetchWithTimeout('https://example.com/slow', {}, 50)).rejects.toThrow(
      /Request timed out after 50ms/
    );
  });

  it('includes URL in timeout error message', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    await expect(fetchWithTimeout('https://api.hetzner.cloud/v1/servers', {}, 50)).rejects.toThrow(
      'Request timed out after 50ms: https://api.hetzner.cloud/v1/servers'
    );
  });

  it('propagates non-timeout errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Network error'));

    await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
      'Network error'
    );
  });

  it('clears timeout on successful fetch', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const mockResponse = new Response('ok', { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await fetchWithTimeout('https://example.com', {}, 5000);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
