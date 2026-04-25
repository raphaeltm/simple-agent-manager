import {
  DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS,
  DEFAULT_MCP_TOKEN_TTL_SECONDS,
  DEFAULT_TASK_RUN_MAX_EXECUTION_MS,
} from '@simple-agent-manager/shared';
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

  describe('getMcpTokenMaxLifetime', () => {
    it('should return default max lifetime when no env provided', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime()).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
    });

    it('should return configured max lifetime from env', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: '7200' })).toBe(7200);
    });

    it('should return default for invalid max lifetime', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: 'invalid' })).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
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
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('should return null for non-existent token', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      mockKV.get.mockResolvedValue(null);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'missing-token');

      expect(result).toBeNull();
      expect(mockKV.get).toHaveBeenCalledWith('mcp:missing-token', { type: 'json' });
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should return data and refresh TTL for valid token', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-07T01:00:00Z'));
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
      expect(mockKV.put).toHaveBeenCalledWith(
        'mcp:valid-token',
        JSON.stringify(data),
        { expirationTtl: DEFAULT_MCP_TOKEN_TTL_SECONDS },
      );
      // MCP tokens are NOT consumed on validation (unlike bootstrap tokens)
      expect(mockKV.delete).not.toHaveBeenCalled();
    });

    it('should refresh TTL using configured env values', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-07T01:00:00Z'));
      const data = {
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt: '2026-03-07T00:00:00Z',
      };
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'valid-token', {
        MCP_TOKEN_TTL_SECONDS: '3600',
        MCP_TOKEN_MAX_LIFETIME_SECONDS: '7200',
      });

      expect(result).toEqual(data);
      expect(mockKV.put).toHaveBeenCalledWith(
        'mcp:valid-token',
        JSON.stringify(data),
        { expirationTtl: 3600 },
      );
    });

    it('should remain valid beyond the original 4 hour TTL while actively refreshed', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      vi.useFakeTimers();
      mockKV.get.mockResolvedValue({
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt: '2026-03-07T00:00:00Z',
      });

      vi.setSystemTime(new Date('2026-03-07T03:59:00Z'));
      await validateMcpToken(mockKV as unknown as KVNamespace, 'still-valid');

      vi.setSystemTime(new Date('2026-03-07T04:30:00Z'));
      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'still-valid');

      expect(result).not.toBeNull();
      expect(mockKV.put).toHaveBeenCalledTimes(2);
      expect(mockKV.put).toHaveBeenNthCalledWith(
        2,
        'mcp:still-valid',
        JSON.stringify({
          taskId: 'task-123',
          projectId: 'proj-456',
          userId: 'user-789',
          workspaceId: 'ws-abc',
          createdAt: '2026-03-07T00:00:00Z',
        }),
        { expirationTtl: DEFAULT_MCP_TOKEN_TTL_SECONDS },
      );
    });

    it('should reject tokens older than the configured max lifetime', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T01:00:01Z'));
      mockKV.get.mockResolvedValue({
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt: '2026-03-07T00:00:00Z',
      });

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'expired-token');

      expect(result).toBeNull();
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should reject tokens with invalid creation timestamps', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      mockKV.get.mockResolvedValue({
        taskId: 'task-123',
        projectId: 'proj-456',
        userId: 'user-789',
        workspaceId: 'ws-abc',
        createdAt: 'not-a-date',
      });

      const result = await validateMcpToken(mockKV as unknown as KVNamespace, 'bad-token');

      expect(result).toBeNull();
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
