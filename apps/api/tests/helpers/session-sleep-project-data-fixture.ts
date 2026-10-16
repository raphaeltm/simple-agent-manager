/** Shared real SQLite chat and durable-delivery hooks for canonical sleep tests. */
import Database from 'better-sqlite3';
import { expect, vi } from 'vitest';

import { runMigrations } from '../../src/durable-objects/migrations';
import type { DurabilityFoundationHooks } from '../../src/durable-objects/project-data/durability-foundation';
import { sleepSession as sleepChatSession } from '../../src/durable-objects/project-data/sessions';
import type { Env } from '../../src/env';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

type SleepMocks = Pick<
  typeof import('./session-sleep-fixture').sleepBoundaryMocks,
  'getSession' | 'sleepSession'
>;
export function createSleepProjectDataFixture(
  d1: Database.Database,
  mocks: SleepMocks,
  identity: {
    projectId: string;
    userId: string;
    chatId: string;
    taskId: string;
    startedAt: Date;
  }
) {
  const {
    projectId: PROJECT,
    userId: USER,
    chatId: CHAT,
    taskId: TASK,
    startedAt: START,
  } = identity;
  d1.prepare("INSERT INTO users (id, status) VALUES (?, 'active')").run(USER);
  d1.prepare(
    "INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'maintainer', 'active')"
  ).run(PROJECT, USER);
  d1.prepare('UPDATE projects SET user_id = ? WHERE id = ?').run(USER, PROJECT);
  // A VM task submission links its chat; the fixture's snapshot row predates the VM runtime.
  d1.prepare("UPDATE tasks SET chat_session_id = ?, task_mode = 'task' WHERE id = ?").run(
    CHAT,
    TASK
  );
  d1.prepare("UPDATE session_snapshots SET runtime = 'vm' WHERE chat_session_id = ?").run(CHAT);

  const doDb = new Database(':memory:');
  const sql = createSqlStorage(doDb);
  runMigrations(sql);
  sql.exec(
    `INSERT INTO chat_sessions
    (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, 'workspace-1', ?, 'Task conversation', 'active', 1, ?, ?, ?)`,
    CHAT,
    TASK,
    START.getTime(),
    START.getTime(),
    START.getTime()
  );
  // The VM teardown reads and transitions the chat through the real ProjectData functions.
  mocks.getSession.mockImplementation((_env: Env, _projectId: string, sessionId: string) => {
    const row = doDb
      .prepare(
        'SELECT id, status, task_id AS taskId, workspace_id AS workspaceId FROM chat_sessions WHERE id = ?'
      )
      .get(sessionId);
    return Promise.resolve(row ?? null);
  });
  mocks.sleepSession.mockImplementation(
    (_env: Env, _projectId: string, sessionId: string, options?: object) =>
      Promise.resolve(sleepChatSession(sql, sessionId, options))
  );
  const deliveries: Promise<unknown>[] = [];
  const hooks: DurabilityFoundationHooks = {
    getProjectId: () => PROJECT,
    transactionSync: <T>(fn: () => T): T => doDb.transaction(fn)(),
    waitUntil: (promise) => {
      deliveries.push(promise);
    },
    recalculateAlarm: vi.fn(async () => undefined),
    scheduleSummarySync: vi.fn(),
    broadcastEvent: vi.fn(),
    armIdleCleanup: vi.fn(),
    nudgeDeliveries: vi.fn(() => 0),
  };
  return {
    doDb,
    sql,
    hooks,
    deliveries,
    assertSleeping() {
      expect(d1.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)).toEqual({
        status: 'sleeping',
      });
      expect(d1.prepare('SELECT status FROM workspaces WHERE id = ?').get('workspace-1')).toEqual({
        status: 'sleeping',
      });
      expect(doDb.prepare('SELECT status FROM chat_sessions WHERE id = ?').get(CHAT)).toEqual({
        status: 'sleeping',
      });
    },
  };
}
