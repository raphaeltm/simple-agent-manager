import type { BootstrapResponse, BootstrapTokenData } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSqliteD1 } from '../../helpers/sqlite-d1';

// Mock rate-limit middleware to be a passthrough (tested separately)
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => vi.fn(async (_c: any, next: any) => { await next(); }),
  getRateLimit: vi.fn(),
}));

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

// Mock environment
const mockEnv = {
  KV: mockKV,
  DATABASE: undefined as unknown as D1Database,
  ENCRYPTION_KEY: 'iZEI8rg5FHtTo2yvt6Qw3m4z6aTfqj5MdLEGqOvdqw0=', // Valid 32-byte base64 key
  BASE_DOMAIN: 'workspaces.example.com',
};

let sqlite: Database.Database;

function installBootstrapLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE bootstrap_token_consumes (
      token_hash TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
  `);
}

describe('Bootstrap Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    installBootstrapLedger(sqlite);
    mockEnv.DATABASE = createSqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
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
      const { ciphertext: encCallback, iv: ivCallback } = await encrypt(
        'jwt-callback-token',
        mockEnv.ENCRYPTION_KEY
      );

      const tokenData: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: encHetzner,
        hetznerTokenIv: ivHetzner,
        encryptedCallbackToken: encCallback,
        callbackTokenIv: ivCallback,
        encryptedGithubToken: encGithub,
        githubTokenIv: ivGithub,
        gitUserName: 'Octo Cat',
        gitUserEmail: 'octo@example.com',
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
      expect(body.gitUserName).toBe('Octo Cat');
      expect(body.gitUserEmail).toBe('octo@example.com');
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
        gitUserName: null,
        gitUserEmail: null,
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
        gitUserName: null,
        gitUserEmail: null,
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
      expect(body.gitUserName).toBeNull();
      expect(body.gitUserEmail).toBeNull();
    });

    it('rejects concurrent replay across requests using the D1 consume ledger', async () => {
      const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
      const { encrypt } = await import('../../../src/services/encryption');

      const app = new Hono();
      app.route('/api/bootstrap', bootstrapRoutes);

      const { ciphertext, iv } = await encrypt('hetzner-token', mockEnv.ENCRYPTION_KEY);
      const tokenData: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: ciphertext,
        hetznerTokenIv: iv,
        callbackToken: 'jwt-token',
        encryptedGithubToken: null,
        githubTokenIv: null,
        gitUserName: null,
        gitUserEmail: null,
        createdAt: new Date().toISOString(),
      };

      mockKV.get.mockResolvedValue(tokenData);

      const first = app.request('/api/bootstrap/concurrent-token', { method: 'POST' }, mockEnv);
      const second = app.request('/api/bootstrap/concurrent-token', { method: 'POST' }, mockEnv);

      const [res1, res2] = await Promise.all([first, second]);
      expect([res1.status, res2.status].sort()).toEqual([200, 401]);
      expect(mockKV.delete).toHaveBeenCalledTimes(1);
      expect(mockKV.delete).toHaveBeenCalledWith('bootstrap:concurrent-token');
    });

    it('fails closed when token data is missing callback token material', async () => {
      const { bootstrapRoutes } = await import('../../../src/routes/bootstrap');
      const { encrypt } = await import('../../../src/services/encryption');

      const app = new Hono();
      app.route('/api/bootstrap', bootstrapRoutes);

      const { ciphertext, iv } = await encrypt('hetzner-token', mockEnv.ENCRYPTION_KEY);
      const tokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: ciphertext,
        hetznerTokenIv: iv,
        encryptedGithubToken: null,
        githubTokenIv: null,
        gitUserName: null,
        gitUserEmail: null,
        createdAt: new Date().toISOString(),
      } as BootstrapTokenData;

      mockKV.get.mockResolvedValue(tokenData);

      const res = await app.request('/api/bootstrap/malformed-token', { method: 'POST' }, mockEnv);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('INVALID_TOKEN');
      expect(mockKV.delete).toHaveBeenCalledWith('bootstrap:malformed-token');
    });

  });
});
