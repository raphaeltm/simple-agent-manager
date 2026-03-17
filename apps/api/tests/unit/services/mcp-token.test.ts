import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_MCP_TOKEN_TTL_SECONDS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS } from '@simple-agent-manager/shared';

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
    it('should return default TTL matching task max execution time when no env provided', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL()).toBe(DEFAULT_MCP_TOKEN_TTL_SECONDS);
    });

    it('should return configured TTL from env', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL({ MCP_TOKEN_TTL_SECONDS: '3600' })).toBe(3600);
    });

    it('should return default for invalid env value', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL({ MCP_TOKEN_TTL_SECONDS: 'invalid' })).toBe(DEFAULT_MCP_TOKEN_TTL_SECONDS);
    });

    it('should return default for negative value', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL({ MCP_TOKEN_TTL_SECONDS: '-1' })).toBe(DEFAULT_MCP_TOKEN_TTL_SECONDS);
    });

    it('should return default for zero value', async () => {
      const { getMcpTokenTTL } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenTTL({ MCP_TOKEN_TTL_SECONDS: '0' })).toBe(DEFAULT_MCP_TOKEN_TTL_SECONDS);
    });
  });

  // Regression guard: MCP token TTL must be >= task max execution time.
  // PR #410 reduced the TTL to 30 minutes while tasks can run for 4 hours,
  // which caused all MCP tool calls to fail after 30 minutes (token expired in KV).
  describe('TTL alignment with task execution time', () => {
    it('should have default constant >= task max execution time in seconds', () => {
      const taskMaxExecutionSeconds = DEFAULT_TASK_RUN_MAX_EXECUTION_MS / 1000;
      expect(DEFAULT_MCP_TOKEN_TTL_SECONDS).toBeGreaterThanOrEqual(taskMaxExecutionSeconds);
    });

    it('should store token with TTL that covers full task execution time', async () => {
      const { storeMcpToken } = await import('../../../src/services/mcp-token');
      const taskMaxExecutionSeconds = DEFAULT_TASK_RUN_MAX_EXECUTION_MS / 1000;

      await storeMcpToken(mockKV as unknown as KVNamespace, 'token', {
        taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w', createdAt: '2026-01-01T00:00:00Z',
      });

      const [, , opts] = mockKV.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      expect(opts.expirationTtl).toBeGreaterThanOrEqual(taskMaxExecutionSeconds);
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
        { expirationTtl: DEFAULT_MCP_TOKEN_TTL_SECONDS },
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
        MCP_TOKEN_TTL_SECONDS: '3600',
      });

      expect(mockKV.put).toHaveBeenCalledWith(
        'mcp:test-token',
        JSON.stringify(data),
        { expirationTtl: 3600 },
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
