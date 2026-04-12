import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/index';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_RATE_LIMITS,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
  getRateLimit,
  rateLimit,
  RateLimitError,
} from '../../../src/middleware/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockKV(store: Map<string, string> = new Map()): KVNamespace {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const val = store.get(key);
      if (!val) return null;
      return type === 'json' ? JSON.parse(val) : val;
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
// rateLimit middleware — behavioral tests
// ---------------------------------------------------------------------------

describe('rateLimit middleware (behavioral)', () => {
  let store: Map<string, string>;
  let kv: KVNamespace;
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    store = new Map();
    kv = createMockKV(store);
    mockEnv = { KV: kv } as Partial<Env>;
  });

  function createApp(options: {
    useIp?: boolean;
    limit?: number;
    keyPrefix?: string;
    injectAuth?: { user: { id: string } };
  }) {
    const app = new Hono<{ Bindings: Env }>();

    // Error handler to surface RateLimitError as 429
    app.onError((err, c) => {
      if (err instanceof RateLimitError) {
        return c.json({ error: 'RATE_LIMIT_EXCEEDED' }, 429);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
    });

    // Optionally inject auth context
    if (options.injectAuth) {
      app.use('/test', async (c, next) => {
        c.set('auth' as any, options.injectAuth);
        await next();
      });
    }

    // Apply rate limit middleware
    app.use(
      '/test',
      rateLimit({
        limit: options.limit ?? 3,
        keyPrefix: options.keyPrefix ?? 'test',
        useIp: options.useIp,
      }) as any,
    );

    app.get('/test', (c) => c.json({ ok: true }));
    return app;
  }

  it('rate limits authenticated users by user ID when useIp is false', async () => {
    const app = createApp({
      useIp: false,
      limit: 2,
      injectAuth: { user: { id: 'user-abc' } },
    });

    // First request — allowed
    const res1 = await app.request('/test', {}, mockEnv);
    expect(res1.status).toBe(200);

    // Second request — allowed
    const res2 = await app.request('/test', {}, mockEnv);
    expect(res2.status).toBe(200);

    // Third request — blocked
    const res3 = await app.request('/test', {}, mockEnv);
    expect(res3.status).toBe(429);

    // Verify KV was keyed on user ID
    const kvPutCalls = (kv.put as any).mock.calls as [string, string][];
    const keys = kvPutCalls.map(([k]) => k);
    expect(keys.every((k) => k.includes('user-abc'))).toBe(true);
  });

  it('falls back to IP-based rate limiting when auth is missing and useIp is false', async () => {
    // No auth injected — simulates unauthenticated request
    const app = createApp({ useIp: false, limit: 2 });

    // Request with CF-Connecting-IP header (no auth)
    const req1 = new Request('http://localhost/test', {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });
    const res1 = await app.request(req1, undefined, mockEnv);
    expect(res1.status).toBe(200);

    // Second request from same IP
    const req2 = new Request('http://localhost/test', {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });
    const res2 = await app.request(req2, undefined, mockEnv);
    expect(res2.status).toBe(200);

    // Third request from same IP — should be blocked
    const req3 = new Request('http://localhost/test', {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });
    const res3 = await app.request(req3, undefined, mockEnv);
    expect(res3.status).toBe(429);

    // Verify KV was keyed on IP, not a user ID
    const kvPutCalls = (kv.put as any).mock.calls as [string, string][];
    const keys = kvPutCalls.map(([k]) => k);
    expect(keys.every((k) => k.includes('1.2.3.4'))).toBe(true);
    expect(keys.every((k) => !k.includes('user-'))).toBe(true);
  });

  it('allows requests from different IPs independently in IP-fallback mode', async () => {
    const app = createApp({ useIp: false, limit: 1 });

    // First IP hits the limit
    const req1 = new Request('http://localhost/test', {
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    });
    const res1 = await app.request(req1, undefined, mockEnv);
    expect(res1.status).toBe(200);

    const req2 = new Request('http://localhost/test', {
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    });
    const res2 = await app.request(req2, undefined, mockEnv);
    expect(res2.status).toBe(429);

    // Different IP is still allowed
    const req3 = new Request('http://localhost/test', {
      headers: { 'CF-Connecting-IP': '2.2.2.2' },
    });
    const res3 = await app.request(req3, undefined, mockEnv);
    expect(res3.status).toBe(200);
  });
});
