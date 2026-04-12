import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
  getRateLimit,
  DEFAULT_RATE_LIMITS,
  DEFAULT_WINDOW_SECONDS,
} from '../../../src/middleware/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockKV(store: Map<string, string> = new Map()): KVNamespace {
  return {
    get: vi.fn(async (key: string) => {
      const val = store.get(key);
      return val ? JSON.parse(val) : null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Unit tests for pure helpers
// ---------------------------------------------------------------------------

describe('rate-limit helpers', () => {
  describe('createRateLimitKey', () => {
    it('creates a structured key from prefix, identifier, and window', () => {
      const key = createRateLimitKey('workspace-create', 'user-123', 1700000000);
      expect(key).toBe('ratelimit:workspace-create:user-123:1700000000');
    });
  });

  describe('getCurrentWindowStart', () => {
    it('returns a window-aligned timestamp', () => {
      const ws = getCurrentWindowStart(3600);
      expect(ws % 3600).toBe(0);
      expect(ws).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });
  });

  describe('getRateLimit', () => {
    it('returns the default when env var is not set', () => {
      const env = {} as any;
      expect(getRateLimit(env, 'WORKSPACE_CREATE')).toBe(DEFAULT_RATE_LIMITS.WORKSPACE_CREATE);
    });

    it('returns parsed env var when valid', () => {
      const env = { RATE_LIMIT_WORKSPACE_CREATE: '50' } as any;
      expect(getRateLimit(env, 'WORKSPACE_CREATE')).toBe(50);
    });

    it('returns default for invalid env var', () => {
      const env = { RATE_LIMIT_WORKSPACE_CREATE: 'abc' } as any;
      expect(getRateLimit(env, 'WORKSPACE_CREATE')).toBe(DEFAULT_RATE_LIMITS.WORKSPACE_CREATE);
    });
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe('checkRateLimit', () => {
  let kv: KVNamespace;
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    kv = createMockKV(store);
  });

  it('allows the first request and sets count to 1', async () => {
    const key = 'ratelimit:test:user1:0';
    const result = await checkRateLimit(kv, key, 5, DEFAULT_WINDOW_SECONDS);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(kv.put).toHaveBeenCalled();
  });

  it('increments the count on subsequent requests', async () => {
    const windowStart = getCurrentWindowStart(DEFAULT_WINDOW_SECONDS);
    const key = `ratelimit:test:user1:${windowStart}`;

    // Seed with count=3
    store.set(key, JSON.stringify({ count: 3, windowStart }));

    const result = await checkRateLimit(kv, key, 5, DEFAULT_WINDOW_SECONDS);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1); // 5 - 4 = 1
  });

  it('blocks requests once the limit is exceeded', async () => {
    const windowStart = getCurrentWindowStart(DEFAULT_WINDOW_SECONDS);
    const key = `ratelimit:test:user1:${windowStart}`;

    // Seed at limit
    store.set(key, JSON.stringify({ count: 5, windowStart }));

    const result = await checkRateLimit(kv, key, 5, DEFAULT_WINDOW_SECONDS);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rateLimit middleware — integration-style tests
// ---------------------------------------------------------------------------

describe('rateLimit middleware', () => {
  // We import the middleware dynamically to avoid Hono + Workers type conflicts
  // in the plain vitest runner. Instead, test the core logic above and verify
  // the IP fallback behavior via the code path analysis.

  it('falls back to IP-based rate limiting when auth is missing (code path verification)', async () => {
    // Read the source to verify the fallback path exists
    // This supplements the behavioral tests above that verify checkRateLimit works
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(process.cwd(), 'src/middleware/rate-limit.ts'),
      'utf8',
    );

    // The old behavior was: if no auth, early-return next() (bypass rate limiting)
    // The new behavior is: if no auth, fall back to getClientIp(c)
    // Verify the unauthenticated branch does NOT have an early return next()
    // (the file still has `return next()` at the end — that's the normal "request allowed" path)
    const authBlock = source.slice(
      source.indexOf('if (!auth?.user?.id)'),
      source.indexOf('identifier = auth.user.id'),
    );
    expect(authBlock).not.toContain('return next()');
    expect(authBlock).toContain('identifier = getClientIp(c)');
    expect(source).toContain('rate_limit.ip_fallback');
  });
});
