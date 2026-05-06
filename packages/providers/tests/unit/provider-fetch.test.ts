import { afterEach,describe, expect, it, vi } from 'vitest';

import { providerFetch, providerFetchWithRetry } from '../../src/provider-fetch';
import {
  computeRetryDelayMs,
  getRetryDelayMs,
  getRetryMaxAttempts,
  getTimeoutMs,
} from '../../src/provider-fetch';
import { ProviderError } from '../../src/types';

describe('getTimeoutMs', () => {
  it('returns default when envValue is undefined', () => {
    expect(getTimeoutMs(undefined, 5000)).toBe(5000);
  });

  it('returns default when envValue is empty string', () => {
    expect(getTimeoutMs('', 5000)).toBe(5000);
  });

  it('parses valid integer string', () => {
    expect(getTimeoutMs('10000', 5000)).toBe(10000);
  });

  it('returns default for non-numeric string', () => {
    expect(getTimeoutMs('abc', 5000)).toBe(5000);
  });

  it('returns default for zero', () => {
    expect(getTimeoutMs('0', 5000)).toBe(5000);
  });

  it('returns default for negative number', () => {
    expect(getTimeoutMs('-100', 5000)).toBe(5000);
  });

  it('uses 30000 as default when no defaultMs provided', () => {
    expect(getTimeoutMs(undefined)).toBe(30000);
  });
});

describe('providerFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns response on successful fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'ok' }), { status: 200 }),
    );

    const response = await providerFetch('test-provider', 'https://api.example.com/test');
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body).toEqual({ data: 'ok' });
  });

  it('throws ProviderError on HTTP 4xx with JSON error body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
    );

    try {
      await providerFetch('hetzner', 'https://api.example.com/test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.providerName).toBe('hetzner');
      expect(pe.statusCode).toBe(401);
      expect(pe.message).toContain('Unauthorized');
    }
  });

  it('throws ProviderError on HTTP 5xx with text error body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    try {
      await providerFetch('hetzner', 'https://api.example.com/test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.providerName).toBe('hetzner');
      expect(pe.statusCode).toBe(500);
      expect(pe.message).toContain('Internal Server Error');
    }
  });

  it('throws ProviderError on HTTP error with empty body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('', { status: 403 }),
    );

    try {
      await providerFetch('hetzner', 'https://api.example.com/test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.statusCode).toBe(403);
      expect(pe.message).toContain('HTTP 403');
    }
  });

  it('throws ProviderError with timeout message on AbortError', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    // Use a very short timeout to trigger quickly
    try {
      await providerFetch('hetzner', 'https://api.example.com/test', undefined, 10);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.providerName).toBe('hetzner');
      expect(pe.statusCode).toBeUndefined();
      expect(pe.message).toContain('timed out');
      expect(pe.message).toContain('10ms');
    }
  }, 10000);

  it('throws ProviderError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    try {
      await providerFetch('hetzner', 'https://api.example.com/test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.providerName).toBe('hetzner');
      expect(pe.statusCode).toBeUndefined();
      expect(pe.message).toContain('Network error');
      expect(pe.cause).toBeInstanceOf(Error);
    }
  });

  it('passes request init options through', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    await providerFetch('hetzner', 'https://api.example.com/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: JSON.stringify({ data: 'test' }),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: JSON.stringify({ data: 'test' }),
      }),
    );
  });

  it('extracts message from JSON error with top-level message field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Rate limited' }), { status: 429 }),
    );

    try {
      await providerFetch('hetzner', 'https://api.example.com/test');
      expect.fail('Should have thrown');
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe.message).toContain('Rate limited');
      expect(pe.retryable).toBe(true);
      expect(pe.reason).toBe('rate_limit');
    }
  });
});

describe('retry helpers', () => {
  it('parses retry attempts with fallback', () => {
    expect(getRetryMaxAttempts('4')).toBe(4);
    expect(getRetryMaxAttempts('0', 2)).toBe(2);
    expect(getRetryMaxAttempts('abc', 2)).toBe(2);
  });

  it('parses retry delays with fallback', () => {
    expect(getRetryDelayMs('2500', 1000)).toBe(2500);
    expect(getRetryDelayMs('-1', 1000)).toBe(1000);
    expect(getRetryDelayMs('abc', 1000)).toBe(1000);
  });

  it('computes capped exponential retry delays without jitter', () => {
    expect(computeRetryDelayMs(1, 1000, 10000, 0)).toBe(1000);
    expect(computeRetryDelayMs(2, 1000, 10000, 0)).toBe(2000);
    expect(computeRetryDelayMs(5, 1000, 10000, 0)).toBe(10000);
  });
});

describe('providerFetchWithRetry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('retries transient 5xx responses and returns the eventual success', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = mockFetch;

    const promise = providerFetchWithRetry(
      'hetzner',
      'https://api.example.com/test',
      undefined,
      30_000,
      { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 },
    );

    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After for 429 responses', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = mockFetch;

    const promise = providerFetchWithRetry(
      'hetzner',
      'https://api.example.com/test',
      undefined,
      30_000,
      { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 },
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry auth failures', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
    );
    globalThis.fetch = mockFetch;

    await expect(providerFetchWithRetry(
      'hetzner',
      'https://api.example.com/test',
      undefined,
      30_000,
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    )).rejects.toThrow(ProviderError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
