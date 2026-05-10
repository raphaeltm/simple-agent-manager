/**
 * Unit tests for ACP session no-heartbeat sweep.
 *
 * Verifies that checkNoHeartbeatTimeouts() catches sessions in assigned/running
 * with last_heartbeat_at IS NULL and created_at older than the configured timeout,
 * and transitions them to interrupted.
 */
import { ACP_SESSION_DEFAULTS } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import { checkNoHeartbeatTimeouts, computeHeartbeatAlarmTime } from '../../src/durable-objects/project-data/acp-sessions';

function createMockSql(rows: Record<string, unknown>[]) {
  return {
    exec: vi.fn().mockReturnValue({
      toArray: () => rows,
    }),
  } as unknown as SqlStorage;
}

function createMockEnv(overrides: Record<string, string> = {}) {
  return {
    ACP_SESSION_DETECTION_WINDOW_MS: String(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS),
    ACP_SESSION_NO_HEARTBEAT_TIMEOUT_MS: String(ACP_SESSION_DEFAULTS.NO_HEARTBEAT_TIMEOUT_MS),
    ...overrides,
  } as unknown as Parameters<typeof checkNoHeartbeatTimeouts>[1];
}

describe('checkNoHeartbeatTimeouts', () => {
  it('transitions sessions with NULL heartbeat past timeout to interrupted', async () => {
    const now = Date.now();
    const createdAt = now - ACP_SESSION_DEFAULTS.NO_HEARTBEAT_TIMEOUT_MS - 60_000; // 1 min past timeout
    const rows = [
      {
        id: 'session-1',
        chat_session_id: 'chat-1',
        workspace_id: 'ws-1',
        node_id: 'node-1',
      },
    ];

    const sql = createMockSql(rows);
    const env = createMockEnv();
    const transitionFn = vi.fn().mockResolvedValue(undefined);

    const timedOut = await checkNoHeartbeatTimeouts(sql, env, transitionFn);

    expect(transitionFn).toHaveBeenCalledOnce();
    expect(transitionFn).toHaveBeenCalledWith('session-1', 'interrupted', expect.objectContaining({
      actorType: 'alarm',
      reason: 'No heartbeat received within timeout',
    }));
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toEqual({ sessionId: 'session-1', workspaceId: 'ws-1' });
  });

  it('does not transition sessions within the timeout window', async () => {
    // Return empty results (SQL query filters by created_at < cutoff)
    const sql = createMockSql([]);
    const env = createMockEnv();
    const transitionFn = vi.fn();

    const timedOut = await checkNoHeartbeatTimeouts(sql, env, transitionFn);

    expect(transitionFn).not.toHaveBeenCalled();
    expect(timedOut).toHaveLength(0);
  });

  it('uses the SQL query with NULL heartbeat filter', async () => {
    const sql = createMockSql([]);
    const env = createMockEnv();

    await checkNoHeartbeatTimeouts(sql, env, vi.fn());

    expect(sql.exec).toHaveBeenCalledWith(
      expect.stringContaining('last_heartbeat_at IS NULL'),
      expect.any(Number),
    );
    expect(sql.exec).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('assigned', 'running')"),
      expect.any(Number),
    );
  });

  it('respects custom timeout from env var', async () => {
    const customTimeoutMs = 10 * 60 * 1000; // 10 minutes
    const sql = createMockSql([]);
    const env = createMockEnv({ ACP_SESSION_NO_HEARTBEAT_TIMEOUT_MS: String(customTimeoutMs) });

    await checkNoHeartbeatTimeouts(sql, env, vi.fn());

    // The cutoff passed to SQL should be Date.now() - customTimeoutMs
    const callArgs = (sql.exec as ReturnType<typeof vi.fn>).mock.calls[0];
    const cutoff = callArgs[1] as number;
    const expectedCutoff = Date.now() - customTimeoutMs;
    // Allow 1 second tolerance for execution time
    expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(1000);
  });
});

describe('computeHeartbeatAlarmTime with NULL heartbeat sessions', () => {
  it('includes NULL-heartbeat sessions in alarm calculation', () => {
    const now = Date.now();
    const createdAt = now - 5 * 60 * 1000; // 5 min ago

    const sql = {
      exec: vi.fn((query: string) => {
        if (query.includes('last_heartbeat_at IS NOT NULL')) {
          // No sessions with heartbeats
          return { toArray: () => [{ earliest: null }] };
        }
        if (query.includes('last_heartbeat_at IS NULL')) {
          // One session without heartbeat
          return { toArray: () => [{ earliest: createdAt }] };
        }
        return { toArray: () => [] };
      }),
    } as unknown as SqlStorage;

    const env = createMockEnv();
    const alarmTime = computeHeartbeatAlarmTime(sql, env);

    // Should be createdAt + NO_HEARTBEAT_TIMEOUT_MS
    expect(alarmTime).toBe(createdAt + ACP_SESSION_DEFAULTS.NO_HEARTBEAT_TIMEOUT_MS);
  });

  it('returns the earlier of heartbeat and no-heartbeat alarm times', () => {
    const now = Date.now();
    const heartbeatTime = now - 4 * 60 * 1000; // 4 min ago
    const createdAt = now - 25 * 60 * 1000; // 25 min ago

    const sql = {
      exec: vi.fn((query: string) => {
        if (query.includes('last_heartbeat_at IS NOT NULL')) {
          return { toArray: () => [{ earliest: heartbeatTime }] };
        }
        if (query.includes('last_heartbeat_at IS NULL')) {
          return { toArray: () => [{ earliest: createdAt }] };
        }
        return { toArray: () => [] };
      }),
    } as unknown as SqlStorage;

    const env = createMockEnv();
    const alarmTime = computeHeartbeatAlarmTime(sql, env);

    // heartbeat alarm: heartbeatTime + 300_000 (detection window)
    const heartbeatAlarm = heartbeatTime + ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS;
    // no-heartbeat alarm: createdAt + 1_800_000 (30 min)
    const noHbAlarm = createdAt + ACP_SESSION_DEFAULTS.NO_HEARTBEAT_TIMEOUT_MS;

    expect(alarmTime).toBe(Math.min(heartbeatAlarm, noHbAlarm));
  });

  it('returns null when no active sessions exist', () => {
    const sql = {
      exec: vi.fn(() => ({ toArray: () => [{ earliest: null }] })),
    } as unknown as SqlStorage;

    const env = createMockEnv();
    const alarmTime = computeHeartbeatAlarmTime(sql, env);

    expect(alarmTime).toBeNull();
  });
});
