import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../src/do/migrations';
import {
  beginSessionWakeActivation,
  commitSessionWakeActivation,
} from '../../src/do/session-wake-activation-guard';
import { stopSession, wakeSession } from '../../src/do/sessions';
import { createSqlStorage } from '../fixtures/sql-storage';

function makeWakeSql(rowsWritten: number) {
  const exec = vi.fn(() => ({ rowsWritten, toArray: () => [{ found: 1 }] }));
  return { exec } as unknown as Parameters<typeof wakeSession>[0] & {
    exec: ReturnType<typeof vi.fn>;
  };
}

describe('ProjectData wakeSession', () => {
  it('accepts an already-active recovery session on the same workspace without rebinding its task', () => {
    const sql = makeWakeSql(1);

    const updated = wakeSession(sql, 'chat-1', 'workspace-recovery', 'task-recovery');

    expect(updated).toBe(true);
    expect(sql.exec).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('active', 'failed') AND workspace_id = ?"),
      0,
      'workspace-recovery',
      expect.any(Number),
      'chat-1',
      'workspace-recovery',
      0
    );
    expect(sql.exec.mock.calls[0][0]).not.toContain('workspace_id = ? AND task_id = ?');
    expect(sql.exec.mock.calls[0][0]).toContain("? = 1 AND status = 'stopped'");
  });

  it('revives a failed recovery session that is already linked to the same workspace', () => {
    const sql = makeWakeSql(1);

    const updated = wakeSession(sql, 'chat-1', 'workspace-recovery', 'task-recovery');

    expect(updated).toBe(true);
    expect(sql.exec.mock.calls[0][0]).toContain("status IN ('active', 'failed')");
  });

  it('returns false when no sleeping or same-workspace active/failed session is updated', () => {
    const sql = makeWakeSql(0);

    const updated = wakeSession(sql, 'chat-1', 'workspace-other', 'task-recovery');

    expect(updated).toBe(false);
  });

  it('only enables stopped-session wake with caller authority and explicit eviction eligibility', () => {
    const sql = makeWakeSql(1);

    const updated = wakeSession(sql, 'chat-1', 'workspace-recovery', 'task-recovery', {
      allowStopped: true,
    });

    expect(updated).toBe(true);
    expect(sql.exec).toHaveBeenCalledWith(
      expect.stringContaining("? = 1 AND status = 'stopped'"),
      0,
      'workspace-recovery',
      expect.any(Number),
      'chat-1',
      'workspace-recovery',
      1
    );
  });
});

describe('ProjectData wakeSession persisted lifecycle', () => {
  let database: Database.Database;
  let sql: SqlStorage;
  beforeEach(() => {
    database = new Database(':memory:');
    sql = createSqlStorage(database);
    runMigrations(sql);
    sql.exec(`INSERT INTO chat_sessions
      (id,workspace_id,task_id,status,message_count,started_at,created_at,updated_at)
      VALUES ('chat','workspace','original-task','sleeping',0,1,1,1)`);
  });
  afterEach(() => database.close());

  it.each(['sleeping', 'failed', 'active'])(
    'deferred linkage preserves accepted task identity and keeps a %s lifecycle behind handoff',
    (status) => {
      const activation = beginSessionWakeActivation(sql, 'chat', 'workspace', 'older-ready-fence');
      expect(activation).not.toBeNull();
      sql.exec('UPDATE chat_sessions SET status = ? WHERE id = ?', status, 'chat');
      expect(
        wakeSession(sql, 'chat', 'workspace', 'recovery-task', { deferActivation: true })
      ).toBe(true);
      expect(
        sql
          .exec('SELECT status,workspace_id,task_id FROM chat_sessions WHERE id = ?', 'chat')
          .toArray()[0]
      ).toMatchObject({
        status: status === 'active' ? 'active' : 'sleeping',
        workspace_id: 'workspace',
        task_id: 'original-task',
      });
      expect(commitSessionWakeActivation(sql, 'chat', 'workspace', activation, Date.now())).toBe(
        false
      );
    }
  );

  it('default legacy linkage activates a sleeping chat without replacing its owning task', () => {
    expect(wakeSession(sql, 'chat', 'replacement-workspace', 'recovery-task')).toBe(true);
    expect(
      sql
        .exec('SELECT status,workspace_id,task_id FROM chat_sessions WHERE id = ?', 'chat')
        .toArray()[0]
    ).toMatchObject({
      status: 'active',
      workspace_id: 'replacement-workspace',
      task_id: 'original-task',
    });
  });

  it.each([false, true])(
    'allowStopped still requires persisted eviction eligibility (%s)',
    (evicted) => {
      expect(
        stopSession(
          sql,
          'chat',
          undefined,
          evicted ? { source: 'workspace_eviction_finalization' } : undefined
        )
      ).not.toBeNull();
      expect(
        wakeSession(sql, 'chat', 'replacement-workspace', 'recovery-task', {
          allowStopped: true,
          deferActivation: true,
        })
      ).toBe(evicted);
      expect(
        sql.exec('SELECT status,task_id FROM chat_sessions WHERE id = ?', 'chat').toArray()[0]
      ).toMatchObject({ status: evicted ? 'sleeping' : 'stopped', task_id: 'original-task' });
    }
  );
});
