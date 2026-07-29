import type { BootstrapTokenData } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSqliteD1 } from '../../helpers/sqlite-d1';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const mockEnv = {
  ENCRYPTION_KEY: 'iZEI8rg5FHtTo2yvt6Qw3m4z6aTfqj5MdLEGqOvdqw0=',
  DATABASE: undefined as unknown as D1Database,
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

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('Bootstrap Service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    installBootstrapLedger(sqlite);
    mockEnv.DATABASE = createSqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('generateBootstrapToken', () => {
    it('should generate a valid UUID format token', async () => {
      // Import the actual service once implemented
      const { generateBootstrapToken } = await import(
        '../../../src/services/bootstrap'
      );

      const token = generateBootstrapToken();

      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should generate unique tokens', async () => {
      const { generateBootstrapToken } = await import(
        '../../../src/services/bootstrap'
      );

      const tokens = new Set(
        Array.from({ length: 100 }, () => generateBootstrapToken())
      );
      expect(tokens.size).toBe(100);
    });
  });

  describe('storeBootstrapToken', () => {
    it('should store token data in KV with the default TTL', async () => {
      const { storeBootstrapToken } = await import(
        '../../../src/services/bootstrap'
      );

      const token = 'test-token-123';
      const data: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: 'encrypted-hetzner',
        hetznerTokenIv: 'hetzner-iv',
        callbackToken: 'jwt-callback-token',
        encryptedGithubToken: 'encrypted-github',
        githubTokenIv: 'github-iv',
        createdAt: new Date().toISOString(),
      };

      await storeBootstrapToken(
        mockKV as unknown as KVNamespace,
        token,
        data,
        mockEnv
      );

      const storedJson = mockKV.put.mock.calls[0][1] as string;
      const storedData = JSON.parse(storedJson) as BootstrapTokenData;
      expect(storedData.callbackToken).toBeUndefined();
      expect(storedData.encryptedCallbackToken).toEqual(expect.any(String));
      expect(storedData.callbackTokenIv).toEqual(expect.any(String));
      expect(mockKV.put).toHaveBeenCalledWith(`bootstrap:${token}`, storedJson, {
        expirationTtl: 900,
      });
    });
  });

  describe('redeemBootstrapToken (D1 atomic consume + KV payload)', () => {
    it('should return null for non-existent token', async () => {
      const { redeemBootstrapToken } = await import(
        '../../../src/services/bootstrap'
      );

      mockKV.get.mockResolvedValue(null);

      const result = await redeemBootstrapToken(
        mockKV as unknown as KVNamespace,
        'non-existent-token',
        mockEnv
      );

      expect(result).toBeNull();
      expect(mockKV.get).toHaveBeenCalledWith('bootstrap:non-existent-token', {
        type: 'json',
      });
    });

    it('should return data and delete token on successful redemption', async () => {
      const { redeemBootstrapToken } = await import(
        '../../../src/services/bootstrap'
      );

      const { encrypt } = await import('../../../src/services/encryption');

      const encryptedCallbackToken = await encrypt(
        'jwt-callback-token',
        mockEnv.ENCRYPTION_KEY
      );
      const data: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: 'encrypted-hetzner',
        hetznerTokenIv: 'hetzner-iv',
        encryptedCallbackToken: encryptedCallbackToken.ciphertext,
        callbackTokenIv: encryptedCallbackToken.iv,
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };

      mockKV.get.mockResolvedValue(data);

      const result = await redeemBootstrapToken(
        mockKV as unknown as KVNamespace,
        'valid-token',
        mockEnv
      );

      expect(result).toEqual({
        ...data,
        callbackToken: 'jwt-callback-token',
      });
      expect(mockKV.get).toHaveBeenCalledWith('bootstrap:valid-token', {
        type: 'json',
      });
      // Token should be deleted after redemption (single-use)
      expect(mockKV.delete).toHaveBeenCalledWith('bootstrap:valid-token');
    });

    it('allows exactly one concurrent redemption across requests', async () => {
      const { redeemBootstrapToken, registerBootstrapTokenConsume } = await import(
        '../../../src/services/bootstrap'
      );
      const { encrypt } = await import('../../../src/services/encryption');

      const encryptedCallbackToken = await encrypt('jwt-callback-token', mockEnv.ENCRYPTION_KEY);
      const data: BootstrapTokenData = {
        workspaceId: 'ws-atomic',
        encryptedHetznerToken: 'encrypted-hetzner',
        hetznerTokenIv: 'hetzner-iv',
        encryptedCallbackToken: encryptedCallbackToken.ciphertext,
        callbackTokenIv: encryptedCallbackToken.iv,
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };

      await registerBootstrapTokenConsume(
        mockEnv.DATABASE,
        'atomic-token',
        new Date(Date.now() + 60_000).toISOString()
      );
      mockKV.get.mockResolvedValue(data);

      const results = await Promise.all([
        redeemBootstrapToken(mockKV as unknown as KVNamespace, 'atomic-token', mockEnv),
        redeemBootstrapToken(mockKV as unknown as KVNamespace, 'atomic-token', mockEnv),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect(mockKV.delete).toHaveBeenCalledTimes(1);
    });

    it('rejects replay after a successful registered-token consume', async () => {
      const { redeemBootstrapToken, registerBootstrapTokenConsume } = await import(
        '../../../src/services/bootstrap'
      );
      const { encrypt } = await import('../../../src/services/encryption');

      const encryptedCallbackToken = await encrypt('jwt-callback-token', mockEnv.ENCRYPTION_KEY);
      const data: BootstrapTokenData = {
        workspaceId: 'ws-once',
        encryptedHetznerToken: 'encrypted-hetzner',
        hetznerTokenIv: 'hetzner-iv',
        encryptedCallbackToken: encryptedCallbackToken.ciphertext,
        callbackTokenIv: encryptedCallbackToken.iv,
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };

      await registerBootstrapTokenConsume(
        mockEnv.DATABASE,
        'single-use-registered',
        new Date(Date.now() + 60_000).toISOString()
      );
      mockKV.get.mockResolvedValueOnce(data);

      const first = await redeemBootstrapToken(
        mockKV as unknown as KVNamespace,
        'single-use-registered',
        mockEnv
      );
      const second = await redeemBootstrapToken(
        mockKV as unknown as KVNamespace,
        'single-use-registered',
        mockEnv
      );

      expect(first?.workspaceId).toBe('ws-once');
      expect(second).toBeNull();
      expect(mockKV.get).toHaveBeenCalledTimes(1);
    });

    it('fails closed for expired registered tokens without reading KV', async () => {
      const { redeemBootstrapToken, registerBootstrapTokenConsume } = await import(
        '../../../src/services/bootstrap'
      );

      await registerBootstrapTokenConsume(
        mockEnv.DATABASE,
        'expired-registered',
        new Date(Date.now() - 1_000).toISOString()
      );

      const result = await redeemBootstrapToken(
        mockKV as unknown as KVNamespace,
        'expired-registered',
        mockEnv
      );

      expect(result).toBeNull();
      expect(mockKV.get).not.toHaveBeenCalled();
      expect(mockKV.delete).not.toHaveBeenCalled();
    });

    it('allows one KV-only legacy token redemption through atomic insert-wins claim', async () => {
      const { redeemBootstrapToken } = await import('../../../src/services/bootstrap');

      const data: BootstrapTokenData = {
        workspaceId: 'ws-legacy',
        encryptedHetznerToken: 'encrypted-hetzner',
        hetznerTokenIv: 'hetzner-iv',
        callbackToken: 'legacy-callback-token',
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };
      mockKV.get.mockResolvedValue(data);

      const results = await Promise.all([
        redeemBootstrapToken(mockKV as unknown as KVNamespace, 'legacy-kv-only', mockEnv),
        redeemBootstrapToken(mockKV as unknown as KVNamespace, 'legacy-kv-only', mockEnv),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)?.callbackToken).toBe('legacy-callback-token');
      expect(mockKV.delete).toHaveBeenCalledTimes(1);

      const rows = sqlite.prepare('SELECT * FROM bootstrap_token_consumes WHERE token_hash = ?').all(
        await tokenHash('legacy-kv-only')
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ consumed_at: expect.any(Number) });
    });
  });

  describe('Token expiry (KV TTL)', () => {
    it('should not find token after TTL expires', async () => {
      // This is an integration-level test that verifies KV TTL behavior
      // In unit tests, we verify the TTL is correctly set during storage
      const { storeBootstrapToken } = await import(
        '../../../src/services/bootstrap'
      );

      const token = 'expiring-token';
      const data: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: 'encrypted',
        hetznerTokenIv: 'iv',
        callbackToken: 'jwt-callback-token',
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };

      await storeBootstrapToken(
        mockKV as unknown as KVNamespace,
        token,
        data,
        mockEnv
      );

      // Verify the default TTL is used when no override is configured
      expect(mockKV.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 900 })
      );
    });
  });
});
