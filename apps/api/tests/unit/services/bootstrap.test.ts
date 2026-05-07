import type { BootstrapTokenData } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const mockEnv = {
  ENCRYPTION_KEY: 'iZEI8rg5FHtTo2yvt6Qw3m4z6aTfqj5MdLEGqOvdqw0=',
};

describe('Bootstrap Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    it('should store token data in KV with 15-minute TTL', async () => {
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

  describe('redeemBootstrapToken (get + delete for single-use)', () => {
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
        callbackToken: 'jwt',
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

      // Verify TTL is set to 900 seconds (15 minutes)
      expect(mockKV.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 900 })
      );
    });
  });
});
