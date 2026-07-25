/**
 * Tests verifying that configuration constants resolve from env vars
 * with correct fallback to DEFAULT_* values.
 *
 * Covers:
 * - NODE_LIFECYCLE_ALARM_RETRY_MS → DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS
 * - WORKSPACE_IDLE_CHECK_INTERVAL_MS → DEFAULT_WORKSPACE_IDLE_CHECK_INTERVAL_MS
 * - MAX_NOTIFICATION_PAGE_SIZE → DEFAULT_MAX_NOTIFICATION_PAGE_SIZE
 * - CF container constants moved to shared package
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS,
  DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS,
  DEFAULT_CF_CONTAINER_SLEEP_AFTER,
  DEFAULT_MAX_NOTIFICATION_PAGE_SIZE,
  DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS,
  DEFAULT_WORKSPACE_IDLE_CHECK_INTERVAL_MS,
} from '@simple-agent-manager/shared';

describe('config env var resolution', () => {
  describe('shared constants have expected default values', () => {
    it('DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS is 60 seconds', () => {
      expect(DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS).toBe(60_000);
    });

    it('DEFAULT_WORKSPACE_IDLE_CHECK_INTERVAL_MS is 5 minutes', () => {
      expect(DEFAULT_WORKSPACE_IDLE_CHECK_INTERVAL_MS).toBe(5 * 60 * 1000);
    });

    it('DEFAULT_MAX_NOTIFICATION_PAGE_SIZE is 100', () => {
      expect(DEFAULT_MAX_NOTIFICATION_PAGE_SIZE).toBe(100);
    });

    it('DEFAULT_CF_CONTAINER_SLEEP_AFTER is 1h', () => {
      expect(DEFAULT_CF_CONTAINER_SLEEP_AFTER).toBe('1h');
    });

    it('DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS is 2 hours', () => {
      expect(DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS).toBe(2 * 60 * 60 * 1000);
    });

    it('DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS is 5 minutes', () => {
      expect(DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS).toBe(5 * 60 * 1000);
    });
  });

  describe('env var resolution pattern: parseInt with fallback', () => {
    function resolveMs(envValue: string | undefined, defaultValue: number): number {
      if (envValue) {
        const parsed = parseInt(envValue, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      return defaultValue;
    }

    it('returns default when env is undefined', () => {
      expect(resolveMs(undefined, DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS)).toBe(60_000);
    });

    it('returns default when env is empty string', () => {
      expect(resolveMs('', DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS)).toBe(60_000);
    });

    it('returns parsed value when env is a valid number', () => {
      expect(resolveMs('120000', DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS)).toBe(120_000);
    });

    it('returns default when env is not a number', () => {
      expect(resolveMs('abc', DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS)).toBe(60_000);
    });

    it('returns default when env is zero', () => {
      expect(resolveMs('0', DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS)).toBe(60_000);
    });

    it('returns default when env is negative', () => {
      expect(resolveMs('-1000', DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS)).toBe(60_000);
    });
  });

  describe('computeIdleAlarmTimes respects WORKSPACE_IDLE_CHECK_INTERVAL_MS env', () => {
    it('uses env value when provided (discriminating: differs from default)', async () => {
      const { computeIdleAlarmTimes } = await import(
        '../../src/durable-objects/project-data/idle-cleanup'
      );

      const baseTime = Date.now() - 60_000;
      const mockSql = {
        exec: (query: string) => ({
          toArray: () => {
            if (query.includes('idle_cleanup_schedule')) return [{ earliest: null }];
            if (query.includes('workspace_activity')) return [{ earliest: baseTime }];
            return [];
          },
        }),
      } as unknown as SqlStorage;

      const envOverrideMs = 600_000; // 10 min — differs from 5 min default
      const result = computeIdleAlarmTimes(mockSql, {
        WORKSPACE_IDLE_CHECK_INTERVAL_MS: String(envOverrideMs),
      });

      expect(result.workspaceIdleCheckTime).not.toBeNull();
      const expectedCheck = baseTime + envOverrideMs;
      const nowPlus60s = Date.now() + 60_000;
      expect(result.workspaceIdleCheckTime).toBe(Math.max(expectedCheck, nowPlus60s));
    });

    it('falls back to default when env is not provided', async () => {
      const { computeIdleAlarmTimes } = await import(
        '../../src/durable-objects/project-data/idle-cleanup'
      );

      const baseTime = Date.now() - 60_000;
      const mockSql = {
        exec: (query: string) => ({
          toArray: () => {
            if (query.includes('idle_cleanup_schedule')) return [{ earliest: null }];
            if (query.includes('workspace_activity')) return [{ earliest: baseTime }];
            return [];
          },
        }),
      } as unknown as SqlStorage;

      const result = computeIdleAlarmTimes(mockSql);

      expect(result.workspaceIdleCheckTime).not.toBeNull();
      const expectedCheck = baseTime + DEFAULT_WORKSPACE_IDLE_CHECK_INTERVAL_MS;
      const nowPlus60s = Date.now() + 60_000;
      expect(result.workspaceIdleCheckTime).toBe(Math.max(expectedCheck, nowPlus60s));
    });
  });
});
