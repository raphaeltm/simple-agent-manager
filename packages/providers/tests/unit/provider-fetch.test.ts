import { describe, it, expect, vi, afterEach } from 'vitest';
import { providerFetch, getTimeoutMs } from '../../src/provider-fetch';
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
    }
  });
});
