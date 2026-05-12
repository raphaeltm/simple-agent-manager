/**
 * MCP Token Sliding Window — Behavioral Tests
 *
 * Tests for the sliding window refresh mechanism that keeps MCP tokens alive
 * while agents are actively using them, with a hard max lifetime cap.
 *
 * See: apps/api/src/services/mcp-token.ts
 */
import { DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS, DEFAULT_MCP_TOKEN_TTL_SECONDS } from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpTokenData, McpTokenEnv } from '../../../src/services/mcp-token';

const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const kv = mockKV as unknown as KVNamespace;

function makeTokenData(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'task-1',
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('MCP Token Sliding Window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getMcpTokenMaxLifetime', () => {
    it('returns default when no env provided', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime()).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
    });

    it('returns configured value from env', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: '43200' })).toBe(43200);
    });

    it('returns default for invalid env value', async () => {
      const { getMcpTokenMaxLifetime } = await import('../../../src/services/mcp-token');
      expect(getMcpTokenMaxLifetime({ MCP_TOKEN_MAX_LIFETIME_SECONDS: 'invalid' })).toBe(DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS);
    });
  });

  describe('sliding window refresh', () => {
    it('does NOT refresh KV when less than 50% of TTL has elapsed', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const now = new Date('2026-05-12T12:00:00Z');
      const data = makeTokenData({ createdAt: now.toISOString() });
      mockKV.get.mockResolvedValue(data);

      // Advance 1 hour (12.5% of 8h TTL — well under 50%)
      vi.setSystemTime(new Date('2026-05-12T13:00:00Z'));

      const result = await validateMcpToken(kv, 'test-token');
      expect(result).toEqual(data);
      // Should NOT write back to KV (throttled)
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('refreshes KV when more than 50% of TTL has elapsed', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const createdAt = new Date('2026-05-12T12:00:00Z');
      const data = makeTokenData({ createdAt: createdAt.toISOString() });
      mockKV.get.mockResolvedValue(data);

      // Advance 5 hours (62.5% of 8h TTL — over 50% threshold)
      vi.setSystemTime(new Date('2026-05-12T17:00:00Z'));

      const result = await validateMcpToken(kv, 'test-token');
      expect(result).toEqual(data);
      // Should write back to KV with refreshed TTL
      expect(mockKV.put).toHaveBeenCalledTimes(1);
      const [key, value, opts] = mockKV.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      expect(key).toBe('mcp:test-token');
      const parsed = JSON.parse(value) as McpTokenData;
      expect(parsed.lastRefreshedAt).toBe('2026-05-12T17:00:00.000Z');
      expect(opts.expirationTtl).toBe(DEFAULT_MCP_TOKEN_TTL_SECONDS);
    });

    it('uses lastRefreshedAt for throttle calculation when present', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const createdAt = new Date('2026-05-12T08:00:00Z');
      const lastRefreshed = new Date('2026-05-12T14:00:00Z');
      const data = makeTokenData({
        createdAt: createdAt.toISOString(),
        lastRefreshedAt: lastRefreshed.toISOString(),
      });
      mockKV.get.mockResolvedValue(data);

      // 2 hours after last refresh (25% of 8h TTL — under 50%)
      vi.setSystemTime(new Date('2026-05-12T16:00:00Z'));

      await validateMcpToken(kv, 'test-token');
      expect(mockKV.put).not.toHaveBeenCalled();

      // Now 5 hours after last refresh (over 50%)
      vi.setSystemTime(new Date('2026-05-12T19:00:00Z'));
      mockKV.get.mockResolvedValue(data);
      vi.clearAllMocks();

      await validateMcpToken(kv, 'test-token');
      expect(mockKV.put).toHaveBeenCalledTimes(1);
    });
  });

  describe('max lifetime cap', () => {
    it('rejects tokens older than max lifetime', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Created 25 hours ago (over 24h default max)
      const createdAt = new Date('2026-05-11T11:00:00Z');
      const data = makeTokenData({ createdAt: createdAt.toISOString() });
      mockKV.get.mockResolvedValue(data);

      vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));

      const result = await validateMcpToken(kv, 'old-token');
      expect(result).toBeNull();
      // Should revoke the expired token
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:old-token');
    });

    it('accepts tokens just under max lifetime', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Created 23 hours ago (under 24h max)
      const createdAt = new Date('2026-05-11T13:00:00Z');
      const data = makeTokenData({ createdAt: createdAt.toISOString() });
      mockKV.get.mockResolvedValue(data);

      vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));

      const result = await validateMcpToken(kv, 'valid-token');
      expect(result).toEqual(data);
    });

    it('caps refreshed TTL to remaining max lifetime', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Created 20 hours ago — 4 hours remaining before max lifetime
      const createdAt = new Date('2026-05-11T16:00:00Z');
      const data = makeTokenData({ createdAt: createdAt.toISOString() });
      mockKV.get.mockResolvedValue(data);

      vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));

      await validateMcpToken(kv, 'near-max-token');
      // Should refresh since >50% of TTL elapsed since creation
      expect(mockKV.put).toHaveBeenCalledTimes(1);
      const [, , opts] = mockKV.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      // Remaining max lifetime is ~4h = 14400s, which is less than 8h TTL
      expect(opts.expirationTtl).toBeLessThanOrEqual(14400);
      expect(opts.expirationTtl).toBeGreaterThan(0);
    });

    it('respects custom max lifetime from env', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      // Created 5 hours ago
      const createdAt = new Date('2026-05-12T07:00:00Z');
      const data = makeTokenData({ createdAt: createdAt.toISOString() });
      mockKV.get.mockResolvedValue(data);

      vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));

      // Custom max lifetime of 4 hours — token should be rejected
      const env: McpTokenEnv = { MCP_TOKEN_MAX_LIFETIME_SECONDS: '14400' };
      const result = await validateMcpToken(kv, 'short-lived', env);
      expect(result).toBeNull();
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:short-lived');
    });
  });

  describe('fail-closed on malformed createdAt', () => {
    it('revokes token with NaN createdAt', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const data = makeTokenData({ createdAt: 'not-a-date' });
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(kv, 'bad-token');
      expect(result).toBeNull();
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:bad-token');
    });

    it('revokes token with empty createdAt', async () => {
      const { validateMcpToken } = await import('../../../src/services/mcp-token');
      const data = makeTokenData({ createdAt: '' });
      mockKV.get.mockResolvedValue(data);

      const result = await validateMcpToken(kv, 'empty-date');
      expect(result).toBeNull();
      expect(mockKV.delete).toHaveBeenCalledWith('mcp:empty-date');
    });
  });
});
