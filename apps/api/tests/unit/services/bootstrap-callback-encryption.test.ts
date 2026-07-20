/**
 * Bootstrap Callback Token Encryption Tests (F-004)
 *
 * Behavioral tests that exercise the actual bootstrap redemption route
 * to verify encrypted callbackToken decryption works end-to-end.
 */
import type { BootstrapResponse, BootstrapTokenData } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/middleware/rate-limit', () => {
  const continueRequest = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    rateLimit: () => vi.fn(continueRequest),
    getRateLimit: vi.fn(),
  };
});

type KvMock = {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const TEST_ENCRYPTION_KEY = 'iZEI8rg5FHtTo2yvt6Qw3m4z6aTfqj5MdLEGqOvdqw0=';

let kv: KvMock;
let env: {
  KV: KvMock;
  DATABASE: Record<string, never>;
  ENCRYPTION_KEY: string;
  BASE_DOMAIN: string;
};

function resetBootstrapHarness() {
  kv = {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  };
  env = {
    KV: kv,
    DATABASE: {},
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    BASE_DOMAIN: 'workspaces.example.com',
  };
}

async function requestBootstrapToken(token: string) {
  const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
  const app = new Hono();
  app.route('/api/bootstrap', bootstrapRoutes);
  return app.request(`/api/bootstrap/${token}`, { method: 'POST' }, env);
}

describe('Bootstrap Callback Token Encryption (F-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBootstrapHarness();
  });

  it('decrypts encryptedCallbackToken via the bootstrap route', async () => {
    const { encrypt } = await import('../../../src/services/encryption');

    const originalCallbackJwt = 'eyJhbGciOiJSUzI1NiJ9.test-callback-jwt-payload';

    // Encrypt callback token using the same key the route will use to decrypt
    const { ciphertext: encCallback, iv: ivCallback } = await encrypt(
      originalCallbackJwt,
      env.ENCRYPTION_KEY
    );
    const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
      'hetzner-token',
      env.ENCRYPTION_KEY
    );

    const tokenData: BootstrapTokenData = {
      workspaceId: 'ws-enc-test',
      encryptedHetznerToken: encHetzner,
      hetznerTokenIv: ivHetzner,
      encryptedCallbackToken: encCallback,
      callbackTokenIv: ivCallback,
      // No plaintext callbackToken — new-style encrypted data
      encryptedGithubToken: null,
      githubTokenIv: null,
      createdAt: new Date().toISOString(),
    };

    kv.get.mockResolvedValue(tokenData);

    const res = await requestBootstrapToken('encrypted-callback-token');

    expect(res.status).toBe(200);
    const body: BootstrapResponse = await res.json();
    expect(body.callbackToken).toBe(originalCallbackJwt);
    expect(body.workspaceId).toBe('ws-enc-test');
  });

  it('falls back to plaintext callbackToken for legacy in-flight tokens (legacy callback token compatibility)', async () => {
    const { encrypt } = await import('../../../src/services/encryption');

    const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
      'hetzner-token',
      env.ENCRYPTION_KEY
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T08:00:00.000Z'));

    const tokenData: BootstrapTokenData = {
      workspaceId: 'ws-legacy',
      encryptedHetznerToken: encHetzner,
      hetznerTokenIv: ivHetzner,
      callbackToken: 'plaintext-legacy-jwt',
      // No encrypted callback fields — legacy format
      encryptedGithubToken: null,
      githubTokenIv: null,
      createdAt: '2026-07-18T07:50:00.000Z',
    };

    kv.get.mockResolvedValue(tokenData);

    try {
      const res = await requestBootstrapToken('legacy-callback-token');

      expect(res.status).toBe(200);
      const body: BootstrapResponse = await res.json();
      expect(body.callbackToken).toBe('plaintext-legacy-jwt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects stale plaintext callbackToken legacy data beyond bootstrap TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T08:00:00.000Z'));
    const { encrypt } = await import('../../../src/services/encryption');

    const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
      'hetzner-token',
      env.ENCRYPTION_KEY
    );

    const tokenData: BootstrapTokenData = {
      workspaceId: 'ws-stale-legacy',
      encryptedHetznerToken: encHetzner,
      hetznerTokenIv: ivHetzner,
      callbackToken: 'stale-plaintext-legacy-jwt',
      encryptedGithubToken: null,
      githubTokenIv: null,
      createdAt: '2026-07-18T07:40:00.000Z',
    };

    kv.get.mockResolvedValue(tokenData);

    try {
      const res = await requestBootstrapToken('stale-legacy-callback-token');
      expect(res.status).toBe(401);
      expect(kv.delete).toHaveBeenCalledWith('bootstrap:stale-legacy-callback-token');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects bootstrap data when both encrypted and plaintext callback fields are absent', async () => {
    const { encrypt } = await import('../../../src/services/encryption');

    const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
      'hetzner-token',
      env.ENCRYPTION_KEY
    );

    // Edge case: neither encrypted nor plaintext callbackToken present
    const tokenData: BootstrapTokenData = {
      workspaceId: 'ws-no-callback',
      encryptedHetznerToken: encHetzner,
      hetznerTokenIv: ivHetzner,
      // No callbackToken, no encryptedCallbackToken
      encryptedGithubToken: null,
      githubTokenIv: null,
      createdAt: new Date().toISOString(),
    };

    kv.get.mockResolvedValue(tokenData);

    const res = await requestBootstrapToken('no-callback-token');

    expect(res.status).toBe(401);
  });
});
