import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../src/durable-objects/migrations';
import {
  checkHeartbeatTimeouts,
  computeHeartbeatAlarmTime,
} from '../../src/durable-objects/project-data/acp-sessions';
import type { Env } from '../../src/durable-objects/project-data/types';
import { createSqlStorage } from './durable-objects/sql-storage-test-utils';

describe('ACP heartbeat timeout policy', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const now = Date.UTC(2026, 6, 21, 16, 35, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    db.prepare(
      `INSERT INTO chat_sessions
       (id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('chat-1', 'Idle recovery', 'active', 0, ?, ?, ?)`
    ).run(now - 600_000, now - 600_000, now - 600_000);
    db.prepare(
      `INSERT INTO acp_sessions
       (id, chat_session_id, workspace_id, node_id, status, agent_type,
        last_heartbeat_at, created_at, updated_at)
       VALUES ('acp-1', 'chat-1', 'ws-1', 'node-1', 'running', 'claude-code', ?, ?, ?)`
    ).run(now - 600_000, now - 600_000, now - 600_000);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('does not terminalize a stale ACP session while its runtime is resumable', async () => {
    const transition = vi.fn().mockResolvedValue(undefined);
    const shouldDeferTimeout = vi.fn().mockResolvedValue({
      defer: true,
      reason: 'cf_container_sleeping',
    });

    const timedOut = await checkHeartbeatTimeouts(
      sql,
      { ACP_SESSION_DETECTION_WINDOW_MS: '300000' } as Env,
      transition,
      { shouldDeferTimeout }
    );

    expect(shouldDeferTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acp-1', workspaceId: 'ws-1', nodeId: 'node-1' })
    );
    expect(transition).not.toHaveBeenCalled();
    expect(timedOut).toEqual([]);
  });

  it('still terminalizes a stale ACP session after the runtime is conclusively terminal', async () => {
    const transition = vi.fn().mockResolvedValue(undefined);

    const timedOut = await checkHeartbeatTimeouts(
      sql,
      { ACP_SESSION_DETECTION_WINDOW_MS: '300000' } as Env,
      transition,
      {
        shouldDeferTimeout: vi.fn().mockResolvedValue({
          defer: false,
          reason: 'cf_container_error',
        }),
      }
    );

    expect(transition).toHaveBeenCalledWith(
      'acp-1',
      'interrupted',
      expect.objectContaining({ actorType: 'alarm' })
    );
    expect(timedOut).toEqual([{ sessionId: 'acp-1', workspaceId: 'ws-1' }]);
  });

  it('defers conservatively when runtime inspection fails', async () => {
    const transition = vi.fn().mockResolvedValue(undefined);

    const timedOut = await checkHeartbeatTimeouts(
      sql,
      { ACP_SESSION_DETECTION_WINDOW_MS: '300000' } as Env,
      transition,
      {
        shouldDeferTimeout: vi.fn().mockRejectedValue(new Error('DO unavailable')),
      }
    );

    expect(transition).not.toHaveBeenCalled();
    expect(timedOut).toEqual([]);
  });

  it('backs off the next alarm when a stale session was deliberately deferred', () => {
    const nextAlarm = computeHeartbeatAlarmTime(sql, {
      ACP_SESSION_DETECTION_WINDOW_MS: '300000',
    } as Env);

    expect(nextAlarm).toBeGreaterThanOrEqual(now + 300_000);
  });
});
