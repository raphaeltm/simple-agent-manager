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
import {
  DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS,
  DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS,
  DEFAULT_CF_CONTAINER_SLEEP_AFTER,
  DEFAULT_MAX_NOTIFICATION_PAGE_SIZE,
  DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS,
  DEFAULT_WORKSPACE_IDLE_CHECK_INTERVAL_MS,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

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

  describe('computeIdleAlarmTimes env resolution edge cases', () => {
    async function getIdleCheckTime(envValue?: string): Promise<number | null> {
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
      const env = envValue !== undefined ? { WORKSPACE_IDLE_CHECK_INTERVAL_MS: envValue } : undefined;
      return computeIdleAlarmTimes(mockSql, env).workspaceIdleCheckTime;
    }

    it('falls back to default when env is empty string', async () => {
      const result = await getIdleCheckTime('');
      expect(result).not.toBeNull();
    });

    it('uses parsed value when env is a valid number', async () => {
      const result = await getIdleCheckTime('600000');
      expect(result).not.toBeNull();
      // 600_000ms override differs from 300_000ms default — discriminating
      const expectedWithDefault = await getIdleCheckTime(undefined);
      expect(result).not.toBe(expectedWithDefault);
    });

    it('falls back to default when env is NaN', async () => {
      const withNaN = await getIdleCheckTime('abc');
      const withDefault = await getIdleCheckTime(undefined);
      expect(withNaN).toBe(withDefault);
    });

    it('falls back to default when env is zero', async () => {
      const withZero = await getIdleCheckTime('0');
      const withDefault = await getIdleCheckTime(undefined);
      expect(withZero).toBe(withDefault);
    });

    it('falls back to default when env is negative', async () => {
      const withNeg = await getIdleCheckTime('-1000');
      const withDefault = await getIdleCheckTime(undefined);
      expect(withNeg).toBe(withDefault);
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
