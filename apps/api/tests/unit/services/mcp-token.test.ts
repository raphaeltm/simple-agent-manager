import { DEFAULT_MCP_TOKEN_TTL_SECONDS, DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS } from '@simple-agent-manager/shared';
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

    it('should have max lifetime strictly greater than sliding window TTL', () => {
      expect(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS).toBeGreaterThan(DEFAULT_MCP_TOKEN_TTL_SECONDS);
    });
  });

  describe('getMcpTokenMaxLifetime', () => {
    it('should return default max lifetime when no env provided', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime()).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
    });

    it('should return configured max lifetime from env', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: '7200' })).toBe(7200);
    });

    it('should return default for invalid env value', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: 'bad' })).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
    });

    it('should return default for negative value', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: '-100' })).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
    });

    it('should return default for zero value', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: '0' })).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
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

    it('should return data for a freshly created token without KV write (throttled)', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Token just created — sinceLastRefresh ≈ 0, below 50% threshold → no write
      const data = {
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt: new Date().toISOString(),
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'valid-token');

      expect(result).toEqual(data);
      expect(mockKV.get).toHaveBeenCalledWith('mcp:valid-token', { type: 'json' });
      // MCP tokens are NOT consumed on validation (unlike bootstrap tokens)
      expect(mockKV.delete).not.toHaveBeenCalled();
      // No KV write — token was just created, well within throttle window
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should throttle KV writes when <50% of TTL has elapsed since last refresh', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Token was refreshed very recently (1 minute ago)
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour old
        lastRefreshedAt: new Date(Date.now() - 60 * 1000).toISOString(), // refreshed 1 min ago
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'throttled-token');

      expect(result).toEqual(data);
      // Should NOT write to KV — less than 50% of TTL elapsed since last refresh
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should refresh KV when >50% of TTL has elapsed since last refresh', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Token was last refreshed 3 hours ago (> 50% of 4h TTL)
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours old
        lastRefreshedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h since refresh
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'stale-refresh-token');

      expect(result).toEqual(data);
      expect(mockKV.put).toHaveBeenCalledTimes(1);
    });

    it('should cap refresh TTL to remaining max lifetime', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Token created 23.5 hours ago — only 30 min of max lifetime remains
      const createdAt = new Date(Date.now() - 23.5 * 60 * 60 * 1000).toISOString();
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt,
        // No lastRefreshedAt → will definitely trigger a write
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'near-expiry-token');

      expect(result).toEqual(data);
      expect(mockKV.put).toHaveBeenCalledTimes(1);
      const putArgs = mockKV.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      // TTL should be capped to ~30 minutes (1800s), not the full 4h (14400s)
      expect(putArgs[2].expirationTtl).toBeLessThanOrEqual(1800 + 60); // allow 1 min tolerance
      expect(putArgs[2].expirationTtl).toBeGreaterThan(0);
      expect(putArgs[2].expirationTtl).toBeLessThan(DEFAULT_MCP_TOKEN_TTL_SECONDS);
    });

    it('should reject token past max lifetime and revoke it', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Token created 25 hours ago (past the default 24h max)
      const createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const data = {
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt,
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'old-token');

      expect(result).toBeNull();
      // Token should be deleted from KV
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:old-token');
      // TTL should NOT be refreshed for expired tokens
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should respect custom max lifetime from env', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Token created 2 hours ago
      const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt,
      };
      mockKV.get.mockResolvedValue(data);

      // Set max lifetime to 1 hour — token should be rejected
      const result = await validateMcpToken(
        mockKV as unknown as KVNamespace,
        'short-lived-token',
        { MCP_TOKEN_MAX_LIFETIME_SECONDS: '3600' },
      );

      expect(result).toBeNull();
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:short-lived-token');
    });

    // NaN bypass: tokens with missing/empty/malformed createdAt must be revoked (fail-closed)
    it('should revoke token with empty createdAt (NaN bypass prevention)', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt: '',
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'nan-token');

      expect(result).toBeNull();
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:nan-token');
    });

    it('should revoke token with malformed createdAt date string', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        createdAt: 'not-a-date',
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'malformed-token');

      expect(result).toBeNull();
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:malformed-token');
    });

    it('should revoke token when createdAt is missing from data', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Simulate legacy token data stored without createdAt field
      const data = {
        taskId: 'task-1',
        projectId: 'proj-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'no-created-at');

      expect(result).toBeNull();
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:no-created-at');
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
