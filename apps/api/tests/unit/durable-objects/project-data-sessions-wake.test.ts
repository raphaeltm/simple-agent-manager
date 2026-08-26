import { describe, expect, it, vi } from 'vitest';

import { wakeSession } from '../../../src/durable-objects/project-data/sessions';

function makeWakeSql(rowsWritten: number) {
  const exec = vi.fn(() => ({ rowsWritten }));
  return { exec } as unknown as Parameters<typeof wakeSession>[0] & {
    exec: ReturnType<typeof vi.fn>;
  };
}

describe('ProjectData wakeSession', () => {
  it('accepts an already-active recovery session on the same workspace and updates its task', () => {
    const sql = makeWakeSql(1);

    const updated = wakeSession(sql, 'chat-1', 'workspace-recovery', 'task-recovery');

    expect(updated).toBe(true);
    expect(sql.exec).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('active', 'failed') AND workspace_id = ?"),
      'workspace-recovery',
      'task-recovery',
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

  it('only enables stopped-session wake when the recovery caller explicitly authorizes it', () => {
    const sql = makeWakeSql(1);

    const updated = wakeSession(sql, 'chat-1', 'workspace-recovery', 'task-recovery', {
      allowStopped: true,
    });

    expect(updated).toBe(true);
    expect(sql.exec).toHaveBeenCalledWith(
      expect.stringContaining("? = 1 AND status = 'stopped'"),
      'workspace-recovery',
      'task-recovery',
      expect.any(Number),
      'chat-1',
      'workspace-recovery',
      1
    );
  });
});
