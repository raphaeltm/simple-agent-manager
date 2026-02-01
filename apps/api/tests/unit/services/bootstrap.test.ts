import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BootstrapTokenData } from '@simple-agent-manager/shared';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
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
    it('should store token data in KV with 5-minute TTL', async () => {
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

      await storeBootstrapToken(mockKV as unknown as KVNamespace, token, data);

      expect(mockKV.put).toHaveBeenCalledWith(
        `bootstrap:${token}`,
        JSON.stringify(data),
        { expirationTtl: 300 } // 5 minutes
      );
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
        'non-existent-token'
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

      const data: BootstrapTokenData = {
        workspaceId: 'ws-123',
        encryptedHetznerToken: 'encrypted-hetzner',
        hetznerTokenIv: 'hetzner-iv',
        callbackToken: 'jwt-callback-token',
        encryptedGithubToken: null,
        githubTokenIv: null,
        createdAt: new Date().toISOString(),
      };

      mockKV.get.mockResolvedValue(data);

      const result = await redeemBootstrapToken(
        mockKV as unknown as KVNamespace,
        'valid-token'
      );

      expect(result).toEqual(data);
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

      await storeBootstrapToken(mockKV as unknown as KVNamespace, token, data);

      // Verify TTL is set to 300 seconds (5 minutes)
      expect(mockKV.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 300 })
      );
    });
  });
});
