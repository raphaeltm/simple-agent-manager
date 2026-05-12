import { DEFAULT_MCP_TOKEN_TTL_SECONDS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS } from '@simple-agent-manager/shared';
import { beforeEach,describe, expect, it, vi } from 'vitest';

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
    it('should generate a valid base64url token (256-bit entropy)', async () => {
      const { generateMcpToken } = await import('../../../src/services/mcp-token');
      const token = generateMcpToken();
      // 32 bytes → 43 base64url chars without padding
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

  describe('getMcpTokenMaxLifetime', () => {
    it('should return default 24h when no env provided', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime()).toBe(24 * 60 * 60);
    });

    it('should return configured value from env', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: '43200' })).toBe(43200);
    });
  });

  describe('sliding window TTL refresh', () => {
    it('should NOT refresh when env is not provided (backwards compat)', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const data = {
        taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w',
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5h ago
      };
      mockKV.get.mockResolvedValue(data);

      await validateMcpToken(mockKV as unknown as KVNamespace, 'tok');

      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should NOT refresh when less than 50% of TTL has elapsed', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const env = { MCP_TOKEN_TTL_SECONDS: '3600' }; // 1h TTL
      const data = {
        taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w',
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago (< 50% of 1h)
      };
      mockKV.get.mockResolvedValue(data);

      await validateMcpToken(mockKV as unknown as KVNamespace, 'tok', env);

      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should refresh when >50% of TTL has elapsed', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const env = { MCP_TOKEN_TTL_SECONDS: '3600' }; // 1h TTL
      const data = {
        taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w',
        createdAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(), // 40 min ago (> 50% of 1h)
      };
      mockKV.get.mockResolvedValue(data);

      await validateMcpToken(mockKV as unknown as KVNamespace, 'tok', env);

      expect(mockKV.put).toHaveBeenCalledTimes(1);
      const [key, value, opts] = mockKV.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      expect(key).toBe('mcp:tok');
      expect(opts.expirationTtl).toBe(3600);
      // Verify lastRefreshedAt was set
      const refreshedData = JSON.parse(value);
      expect(refreshedData.lastRefreshedAt).toBeDefined();
    });

    it('should NOT refresh when max lifetime is exceeded', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const env = {
        MCP_TOKEN_TTL_SECONDS: '3600',
        MCP_TOKEN_MAX_LIFETIME_SECONDS: '7200', // 2h max
      };
      const data = {
        taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w',
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago (> 2h max)
      };
      mockKV.get.mockResolvedValue(data);

      await validateMcpToken(mockKV as unknown as KVNamespace, 'tok', env);

      // Should not refresh — past max lifetime
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should cap refresh TTL to remaining max lifetime', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const env = {
        MCP_TOKEN_TTL_SECONDS: '3600', // 1h TTL
        MCP_TOKEN_MAX_LIFETIME_SECONDS: '5400', // 1.5h max
      };
      const data = {
        taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w',
        createdAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(), // 50 min ago
      };
      mockKV.get.mockResolvedValue(data);

      await validateMcpToken(mockKV as unknown as KVNamespace, 'tok', env);

      expect(mockKV.put).toHaveBeenCalledTimes(1);
      const [, , opts] = mockKV.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      // Remaining lifetime: 90min - 50min = 40min = 2400s, which is less than 3600s TTL
      expect(opts.expirationTtl).toBeLessThanOrEqual(2400 + 5); // small tolerance for test timing
      expect(opts.expirationTtl).toBeGreaterThan(60);
    });

    it('should use lastRefreshedAt for threshold check when present', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const env = { MCP_TOKEN_TTL_SECONDS: '3600' }; // 1h TTL
      const data = {
        taskId: 't', projectId: 'p', userId: 'u', workspaceId: 'w',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
        lastRefreshedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // refreshed 10min ago
      };
      mockKV.get.mockResolvedValue(data);

      await validateMcpToken(mockKV as unknown as KVNamespace, 'tok', env);

      // 10 min since last refresh < 50% of 1h TTL = should NOT refresh
      expect(mockKV.put).not.toHaveBeenCalled();
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
