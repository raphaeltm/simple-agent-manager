/**
 * `commitContainerWake` clears the sleep markers of a session whose Instant container woke in
 * place; `commitContainerWakeFromSleep` is the container DO's never-throwing variant. The task
 * lookup and the "did this session sleep" check run on real SQLite; the two writes they gate
 * (ProjectData's `wakeSession`, the snapshot's `markSessionSnapshotAwakeInPlace`) are observed.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => ({ wakeSession: vi.fn(), markAwake: vi.fn() }));

vi.mock('../../../src/services/project-data', () => ({ wakeSession: writes.wakeSession }));
vi.mock('../../../src/services/session-snapshots', () => ({
  markSessionSnapshotAwakeInPlace: writes.markAwake,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import {
  commitContainerWake,
  commitContainerWakeFromSleep,
} from '../../../src/services/container-wake-commit';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const TARGET = { projectId: 'project-1', chatSessionId: 'chat-1', workspaceId: 'workspace-1' };

describe('container wake commit', () => {
  let sqlite: Database.Database;
  let env: Env;

  function seedTask(id: string, status: string, updatedAt: string): void {
    sqlite
      .prepare(`INSERT INTO tasks (id, workspace_id, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run(id, TARGET.workspaceId, status, updatedAt);
  }

  function seedSnapshot(markers: { sleepingAt: string | null; sleepStatus: string | null }) {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots (id, chat_session_id, sleeping_at, sleep_status)
         VALUES ('snapshot-1', ?, ?, ?)`
      )
      .run(TARGET.chatSessionId, markers.sleepingAt, markers.sleepStatus);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    writes.wakeSession.mockResolvedValue(true);
    writes.markAwake.mockResolvedValue(undefined);
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.tasks, schema.sessionSnapshots]);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  describe('commitContainerWake', () => {
    // A failed task's preserved workspace wakes under that failed task: its restore dates the
    // preservation episode (`failed-task-preservation-release.ts`), so status is no filter.
    it("commits both markers under the workspace's newest task, whatever its status", async () => {
      seedTask('task-older', 'in_progress', '2026-09-28T10:00:00.000Z');
      seedTask('task-newest', 'failed', '2026-09-28T11:00:00.000Z');

      await expect(commitContainerWake(env, TARGET)).resolves.toBeNull();

      expect(writes.wakeSession).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'workspace-1',
        'task-newest'
      );
      expect(writes.markAwake).toHaveBeenCalledWith(env, 'chat-1', 'task-newest', 'workspace-1');
    });

    it("returns the caller's denial and writes nothing", async () => {
      seedTask('task-1', 'in_progress', '2026-09-28T10:00:00.000Z');

      await expect(commitContainerWake(env, TARGET, async () => 'denied')).resolves.toBe('denied');

      expect(writes.wakeSession).not.toHaveBeenCalled();
      expect(writes.markAwake).not.toHaveBeenCalled();
    });

    it('commits nothing for a workspace without a task', async () => {
      const beforeCommit = vi.fn(async () => null);

      await expect(commitContainerWake(env, TARGET, beforeCommit)).resolves.toBeNull();

      expect(beforeCommit).not.toHaveBeenCalled();
      expect(writes.wakeSession).not.toHaveBeenCalled();
      expect(writes.markAwake).not.toHaveBeenCalled();
    });
  });

  describe('commitContainerWakeFromSleep', () => {
    beforeEach(() => seedTask('task-1', 'in_progress', '2026-09-28T10:00:00.000Z'));

    it.each([
      [
        'a sleep that finalized',
        { sleepingAt: '2026-09-28T10:05:00.000Z', sleepStatus: 'sleeping' },
      ],
      ['only a sleeping timestamp', { sleepingAt: '2026-09-28T10:05:00.000Z', sleepStatus: null }],
      ['only a sleeping status', { sleepingAt: null, sleepStatus: 'sleeping' }],
    ])('commits a session whose snapshot carries %s', async (_case, markers) => {
      seedSnapshot(markers);

      await commitContainerWakeFromSleep(env, TARGET);

      expect(writes.wakeSession).toHaveBeenCalledOnce();
      expect(writes.markAwake).toHaveBeenCalledOnce();
    });

    it.each([
      ['a snapshot with no sleep marker', true],
      ['no snapshot at all', false],
    ])('leaves a session that never slept alone: %s', async (_case, withSnapshot) => {
      if (withSnapshot) seedSnapshot({ sleepingAt: null, sleepStatus: null });

      await commitContainerWakeFromSleep(env, TARGET);

      expect(writes.wakeSession).not.toHaveBeenCalled();
      expect(writes.markAwake).not.toHaveBeenCalled();
    });

    it('logs a failed commit instead of failing the wake', async () => {
      seedSnapshot({ sleepingAt: '2026-09-28T10:05:00.000Z', sleepStatus: 'sleeping' });
      writes.wakeSession.mockRejectedValue(new Error('ProjectData unavailable'));
      const warn = vi.spyOn(log, 'warn');

      await expect(commitContainerWakeFromSleep(env, TARGET)).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        'container_wake_commit.failed',
        expect.objectContaining({ chatSessionId: 'chat-1', error: 'ProjectData unavailable' })
      );
    });
  });
});
