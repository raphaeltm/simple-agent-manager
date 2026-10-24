import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { markTaskFailedIfNonTerminal } from '../../../src/services/task-failure';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const recordTaskLifecycleEventBestEffort = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordTaskLifecycleEventBestEffort,
}));

describe('markTaskFailedIfNonTerminal', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.tasks, schema.taskStatusEvents]);
  });

  afterEach(() => sqlite.close());

  function seedTask(id: string, status: string): void {
    sqlite.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)').run(id, status);
  }

  const consolidatedWriters = [
    'SAM dispatch session creation',
    'SAM dispatch runner startup',
    'SAM retry session creation',
    'SAM retry runner startup',
    'MCP dispatch session creation',
    'MCP dispatch runner startup',
    'MCP dispatch catch cleanup',
    'MCP Instant dispatch',
    'MCP orchestration retry stop',
    'MCP orchestration retry session creation',
    'MCP orchestration retry runner startup',
    'task run session creation',
    'task run runner startup',
    'task submit session creation',
    'task submit runner startup',
    'chat start Instant acceptance',
  ];

  it.each(
    consolidatedWriters.flatMap((writer) =>
      ['completed', 'cancelled'].map((status) => [writer, status] as const)
    )
  )('%s preserves a terminal %s task', async (_writer, status) => {
    seedTask('task-123', status);
    expect(
      await markTaskFailedIfNonTerminal(createSqliteD1(sqlite), 'task-123', 'late failure')
    ).toBe(false);
    expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-123')).toEqual({
      status,
    });
  });

  it.each(consolidatedWriters)('%s still fails its in-progress owner state', async () => {
    seedTask('task-123', 'in_progress');
    expect(
      await markTaskFailedIfNonTerminal(createSqliteD1(sqlite), 'task-123', 'owner failure')
    ).toBe(true);
    expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-123')).toEqual({
      status: 'failed',
    });
  });

  it.each(['queued', 'delegated', 'in_progress'])(
    'marks a %s task failed and records its observed prior status',
    async (status) => {
      seedTask('task-123', status);

      const transitioned = await markTaskFailedIfNonTerminal(
        createSqliteD1(sqlite),
        'task-123',
        'Session creation failed: DO unavailable',
        {
          env: { PROJECT_DATA: {} } as never,
          projectId: 'project-123',
          source: 'test.failure',
        }
      );

      expect(transitioned).toBe(true);
      expect(sqlite.prepare('SELECT status, error_message FROM tasks WHERE id = ?').get('task-123'))
        .toEqual({ status: 'failed', error_message: 'Session creation failed: DO unavailable' });
      expect(
        sqlite
          .prepare('SELECT from_status, to_status, reason FROM task_status_events WHERE task_id = ?')
          .get('task-123')
      ).toEqual({
        from_status: status,
        to_status: 'failed',
        reason: 'Session creation failed: DO unavailable',
      });
      expect(recordTaskLifecycleEventBestEffort).toHaveBeenCalledWith(
        { PROJECT_DATA: {} },
        expect.objectContaining({ fromStatus: status, status: 'failed' })
      );
    }
  );

  it.each(['completed', 'cancelled'])('does not overwrite a %s task', async (status) => {
    seedTask('task-123', status);

    const transitioned = await markTaskFailedIfNonTerminal(
      createSqliteD1(sqlite),
      'task-123',
      'late failure'
    );

    expect(transitioned).toBe(false);
    expect(sqlite.prepare('SELECT status, error_message FROM tasks WHERE id = ?').get('task-123'))
      .toEqual({ status, error_message: null });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM task_status_events').get()).toEqual({
      count: 0,
    });
  });

  it.each([
    ['completed', false],
    ['cancelled', false],
    ['in_progress', true],
  ] as const)(
    'atomically observes a task changed to %s immediately before the failure batch',
    async (winningStatus, expectedTransition) => {
      seedTask('task-123', 'in_progress');
      const base = createSqliteD1(sqlite);
      const racingDatabase = {
        ...base,
        batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
          sqlite.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(winningStatus, 'task-123');
          return base.batch<T>(statements);
        },
      } as D1Database;

      const transitioned = await markTaskFailedIfNonTerminal(
        racingDatabase,
        'task-123',
        'late failure'
      );

      expect(transitioned).toBe(expectedTransition);
      expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-123')).toEqual({
        status: expectedTransition ? 'failed' : winningStatus,
      });
      expect(
        sqlite.prepare('SELECT from_status FROM task_status_events WHERE task_id = ?').get('task-123')
      ).toEqual(expectedTransition ? { from_status: winningStatus } : undefined);
    }
  );

  it('rolls back the task update when event persistence fails', async () => {
    seedTask('task-123', 'in_progress');
    sqlite.exec(`CREATE TRIGGER reject_task_status_event BEFORE INSERT ON task_status_events
      BEGIN SELECT RAISE(ABORT, 'event write rejected'); END`);

    await expect(
      markTaskFailedIfNonTerminal(createSqliteD1(sqlite), 'task-123', 'owner failure')
    ).rejects.toThrow('event write rejected');
    expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-123')).toEqual({
      status: 'in_progress',
    });
  });
});
