import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { BootstrapTokenData, BootstrapResponse } from '@simple-agent-manager/shared';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

// Mock environment
const mockEnv = {
  KV: mockKV,
  DATABASE: {},
  ENCRYPTION_KEY: 'iZEI8rg5FHtTo2yvt6Qw3m4z6aTfqj5MdLEGqOvdqw0=', // Valid 32-byte base64 key
  BASE_DOMAIN: 'workspaces.example.com',
};

describe('Bootstrap Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/bootstrap/:token', () => {
    it('should return 401 for invalid/expired token', async () => {
      // Import bootstrap routes once implemented
      const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');

      const app = new Hono();
      app.route('/api/bootstrap', bootstrapRoutes);

      mockKV.get.mockResolvedValue(null);

      const res = await app.request(
        '/api/bootstrap/invalid-token-123',
        { method: 'POST' },
        mockEnv
      );

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('INVALID_TOKEN');
    });

    it('should return decrypted credentials for valid token', async () => {
      const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
      const { encrypt } = await import('../../../src/services/encryption');

      const app = new Hono();
      app.route('/api/bootstrap', bootstrapRoutes);

      // Encrypt test tokens
      const { ciphertext: encHetzner, iv: ivHetzner } = await encrypt(
        'hetzner-api-token-123',
        mockEnv.ENCRYPTION_KEY
      );
      const { ciphertext: encGithub, iv: ivGithub } = await encrypt(
        'github-token-456',
        mockEnv.ENCRYPTION_KEY
      );

      const tokenData: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: encHetzner,
        hetznerTokenIv: ivHetzner,
        callbackToken: 'jwt-callback-token',
        encryptedGithubToken: encGithub,
        githubTokenIv: ivGithub,
        createdAt: new Date().toISOString(),
      };

      mockKV.get.mockResolvedValue(tokenData);

      const res = await app.request(
        '/api/bootstrap/valid-token-abc',
        { method: 'POST' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body: BootstrapResponse = await res.json();

      expect(body.workspaceId).toBe('ws-123');
      expect(body.hetznerToken).toBe('hetzner-api-token-123');
      expect(body.callbackToken).toBe('jwt-callback-token');
      expect(body.githubToken).toBe('github-token-456');
      expect(body.controlPlaneUrl).toContain(mockEnv.BASE_DOMAIN);

      // Verify token was deleted (single-use enforcement)
      expect(mockKV.delete).toHaveBeenCalledWith('bootstrap:valid-token-abc');
    });

    it('should enforce single-use by deleting token after redemption', async () => {
      const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
      const { encrypt } = await import('../../../src/services/encryption');

      const app = new Hono();
      app.route('/api/bootstrap', bootstrapRoutes);

      const { ciphertext, iv } = await encrypt(
        'hetzner-token',
        mockEnv.ENCRYPTION_KEY
      );

      const tokenData: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: ciphertext,
        hetznerTokenIv: iv,
        callbackToken: 'jwt-token',
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };

      // First request - token exists
      mockKV.get.mockResolvedValueOnce(tokenData);

      const res1 = await app.request(
        '/api/bootstrap/single-use-token',
        { method: 'POST' },
        mockEnv
      );
      expect(res1.status).toBe(200);

      // Token should be deleted after first redemption
      expect(mockKV.delete).toHaveBeenCalledWith('bootstrap:single-use-token');

      // Second request - token no longer exists
      mockKV.get.mockResolvedValueOnce(null);

      const res2 = await app.request(
        '/api/bootstrap/single-use-token',
        { method: 'POST' },
        mockEnv
      );
      expect(res2.status).toBe(401);
    });

    it('should handle missing github token gracefully', async () => {
      const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
      const { encrypt } = await import('../../../src/services/encryption');

      const app = new Hono();
      app.route('/api/bootstrap', bootstrapRoutes);

      const { ciphertext, iv } = await encrypt(
        'hetzner-token',
        mockEnv.ENCRYPTION_KEY
      );

      const tokenData: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: ciphertext,
        hetznerTokenIv: iv,
        callbackToken: 'jwt-token',
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };

      mockKV.get.mockResolvedValue(tokenData);

      const res = await app.request(
        '/api/bootstrap/no-github-token',
        { method: 'POST' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body: BootstrapResponse = await res.json();
      expect(body.githubToken).toBeNull();
    });
  });
});
