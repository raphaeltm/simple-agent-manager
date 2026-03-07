import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

describe('MCP Token Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateMcpToken', () => {
    it('should generate a valid UUID format token', async () => {
      const { generateMcpToken } = await import('../../../src/services/mcp-token');
      const token = generateMcpToken();
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('should generate unique tokens', async () => {
      const { generateMcpToken } = await import('../../../src/services/mcp-token');
      const tokens = new Set(Array.from({ length: 100 }, () => generateMcpToken()));
      expect(tokens.size).toBe(100);
    });
  });

  describe('getMcpTokenTTL', () => {
    it('should return default TTL (7200) when no env provided', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL()).toBe(7200);
    });

    it('should return configured TTL from env', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL({ MCP_TOKEN_TTL_SECONDS: '3600' })).toBe(3600);
    });

    it('should return default for invalid env value', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL({ MCP_TOKEN_TTL_SECONDS: 'invalid' })).toBe(7200);
    });

    it('should return default for negative value', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL({ MCP_TOKEN_TTL_SECONDS: '-1' })).toBe(7200);
    });
  });

  describe('storeMcpToken', () => {
    it('should store token data in KV with default TTL', async () => {
      const { storeMcpToken } = await import('../../../src/services/mcp-token');

      const token = 'test-mcp-token';
      const data = {
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt: '2026-03-07T00:00:00Z',
      };

      await storeMcpToken(mockKV as unknown as KVNamespace, token, data);

      expect(mockKV.put).toHaveBeenCalledWith(
        'mcp:test-mcp-token',
        JSON.stringify(data),
        { expirationTtl: 7200 },
      );
    });

    it('should respect custom TTL from env', async () => {
      const { storeMcpToken } = await import('../../../src/services/mcp-token');

      const token = 'test-token';
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt: '2026-03-07T00:00:00Z',
      };

      await storeMcpToken(mockKV as unknown as KVNamespace, token, data, {
        MCP_TOKEN_TTL_SECONDS: '1800',
      });

      expect(mockKV.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { expirationTtl: 1800 },
      );
    });
  });

  describe('validateMcpToken', () => {
    it('should return null for non-existent token', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      mockKV.get.mockResolvedValue(null);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'missing-token');

      expect(result).toBeNull();
      expect(mockKV.get).toHaveBeenCalledWith('mcp:missing-token', { type: 'json' });
    });

    it('should return data without deleting for valid token', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const data = {
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt: '2026-03-07T00:00:00Z',
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'valid-token');

      expect(result).toEqual(data);
      expect(mockKV.get).toHaveBeenCalledWith('mcp:valid-token', { type: 'json' });
      // MCP tokens are NOT consumed on validation (unlike bootstrap tokens)
      expect(mockKV.delete).not.toHaveBeenCalled();
    });
  });

  describe('revokeMcpToken', () => {
    it('should delete token from KV', async () => {
      const { revokeMcpToken } = await import('../../../src/services/mcp-token');

      await revokeMcpToken(mockKV as unknown as KVNamespace, 'token-to-revoke');

      expect(mockKV.delete).toHaveBeenCalledWith('mcp:token-to-revoke');
    });
  });
});
