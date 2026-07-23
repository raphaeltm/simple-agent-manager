import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getMaxProviderErrorBodyChars,
  getTimeoutMs,
  providerFetch,
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

describe('getMaxProviderErrorBodyChars', () => {
  it('returns default for missing or invalid env values', () => {
    expect(getMaxProviderErrorBodyChars(undefined, 2048)).toBe(2048);
    expect(getMaxProviderErrorBodyChars('0', 2048)).toBe(2048);
    expect(getMaxProviderErrorBodyChars('bad', 2048)).toBe(2048);
  });

  it('parses valid positive integer strings', () => {
    expect(getMaxProviderErrorBodyChars('1024', 2048)).toBe(1024);
  });
});

describe('providerFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns response on successful fetch', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));

    const response = await providerFetch('test-provider', 'https://api.example.com/test');
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body).toEqual({ data: 'ok' });
  });

  it('throws ProviderError on HTTP 4xx with JSON error body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 })
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
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

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
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 403 }));

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
      })
    );
  });

  it('bounds non-JSON provider error bodies in normalized ProviderError messages', async () => {
    const longBody = 'provider failure: ' + 'x'.repeat(10_000) + 'DO_NOT_LEAK_TAIL';
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(longBody, { status: 502 })));

    await expect(providerFetch('hetzner', 'https://api.example.com/test')).rejects.toMatchObject({
      providerName: 'hetzner',
      statusCode: 502,
    });

    try {
      await providerFetch('hetzner', 'https://api.example.com/test', undefined, undefined, 256);
      expect.fail('Should have thrown');
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe.message).toContain('provider failure:');
      expect(pe.message).toContain('truncated');
      expect(pe.message).not.toContain('DO_NOT_LEAK_TAIL');
      expect(pe.message.length).toBeLessThan(400);
    }
  });

  it('bounds JSON provider error messages in normalized ProviderError messages', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'bad ' + 'y'.repeat(10_000), code: 'rate_limit' } }),
          { status: 429 }
        )
      );

    try {
      await providerFetch('hetzner', 'https://api.example.com/test');
      expect.fail('Should have thrown');
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe.providerCode).toBe('rate_limit');
      expect(pe.message).toContain('truncated');
      expect(pe.message.length).toBeLessThan(4_500);
    }
  });

  it('extracts message from JSON error with top-level message field', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'Rate limited' }), { status: 429 })
      );

    try {
      await providerFetch('hetzner', 'https://api.example.com/test');
      expect.fail('Should have thrown');
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe.message).toContain('Rate limited');
    }
  });

  // Vultr errors are `{ "error": "<flat string>", "status": <int> }` — the top-level
  // `error` is a plain STRING, not a nested { code, message } object. The message must
  // be the string itself, NOT the raw JSON blob (which would leak the whole body).
  it('extracts a Vultr-style flat-string error without leaking the raw JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Invalid API key.', status: 401 }), { status: 401 })
      );

    try {
      await providerFetch('vultr', 'https://api.vultr.com/v2/account');
      expect.fail('Should have thrown');
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe).toBeInstanceOf(ProviderError);
      expect(pe.statusCode).toBe(401);
      expect(pe.message).toContain('Invalid API key.');
      // The raw JSON body must NOT be dumped into the message.
      expect(pe.message).not.toContain('{"error"');
    }
  });

  it('still extracts a nested { error: { code, message } } object body (no regression)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'x', message: 'boom' } }), { status: 400 })
      );

    try {
      await providerFetch('vultr', 'https://api.vultr.com/v2/instances');
      expect.fail('Should have thrown');
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe.message).toContain('boom');
      expect(pe.providerCode).toBe('x');
      expect(pe.message).not.toContain('{"error"');
    }
  });
});
