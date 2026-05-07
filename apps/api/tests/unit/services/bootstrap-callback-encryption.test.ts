/**
 * Bootstrap Callback Token Encryption Tests (F-004)
 *
 * Behavioral tests that exercise the actual bootstrap redemption route
 * to verify encrypted callbackToken decryption works end-to-end.
 */
import type { BootstrapResponse, BootstrapTokenData } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock rate-limit middleware to be a passthrough
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => vi.fn(async (_c: any, next: any) => { await next(); }),
  getRateLimit: vi.fn(),
}));

const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const mockEnv = {
  KV: mockKV,
  DATABASE: {},
  ENCRYPTION_KEY: 'iZEI8rg5FHtTo2yvt6Qw3m4z6aTfqj5MdLEGqOvdqw0=',
  BASE_DOMAIN: 'workspaces.example.com',
};

describe('Bootstrap Callback Token Encryption (F-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decrypts encryptedCallbackToken via the bootstrap route', async () => {
    const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
    const { encrypt } = await import('../../../src/services/encryption');

    const app = new Hono();
    app.route('/api/bootstrap', bootstrapRoutes);

    const originalCallbackJwt = 'eyJhbGciOiJSUzI1NiJ9.test-callback-jwt-payload';

    // Encrypt callback token using the same key the route will use to decrypt
    const { ciphertext: encCallback, iv: ivCallback } = await encrypt(
      originalCallbackJwt,
      mockEnv.ENCRYPTION_KEY
    );
    const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
      'hetzner-token',
      mockEnv.ENCRYPTION_KEY
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

    mockKV.get.mockResolvedValue(tokenData);

    const res = await app.request(
      '/api/bootstrap/encrypted-callback-token',
      { method: 'POST' },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body: BootstrapResponse = await res.json();
    expect(body.callbackToken).toBe(originalCallbackJwt);
    expect(body.workspaceId).toBe('ws-enc-test');
  });

  it('falls back to plaintext callbackToken for legacy in-flight tokens', async () => {
    const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
    const { encrypt } = await import('../../../src/services/encryption');

    const app = new Hono();
    app.route('/api/bootstrap', bootstrapRoutes);

    const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
      'hetzner-token',
      mockEnv.ENCRYPTION_KEY
    );

    const tokenData: BootstrapTokenData = {
      workspaceId: 'ws-legacy',
      encryptedHetznerToken: encHetzner,
      hetznerTokenIv: ivHetzner,
      callbackToken: 'plaintext-legacy-jwt',
      // No encrypted callback fields — legacy format
      encryptedGithubToken: null,
      githubTokenIv: null,
      createdAt: new Date().toISOString(),
    };

    mockKV.get.mockResolvedValue(tokenData);

    const res = await app.request(
      '/api/bootstrap/legacy-callback-token',
      { method: 'POST' },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body: BootstrapResponse = await res.json();
    expect(body.callbackToken).toBe('plaintext-legacy-jwt');
  });

  it('returns empty callbackToken when both encrypted and plaintext fields are absent', async () => {
    const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
    const { encrypt } = await import('../../../src/services/encryption');

    const app = new Hono();
    app.route('/api/bootstrap', bootstrapRoutes);

    const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
      'hetzner-token',
      mockEnv.ENCRYPTION_KEY
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

    mockKV.get.mockResolvedValue(tokenData);

    const res = await app.request(
      '/api/bootstrap/no-callback-token',
      { method: 'POST' },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body: BootstrapResponse = await res.json();
    // Falls through to empty string — the VM agent will fail with 401 on first use
    // This is the expected backward-compat behavior for partially-written KV data
    expect(body.callbackToken).toBe('');
  });
});
