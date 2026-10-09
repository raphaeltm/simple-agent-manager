import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { isUserConversationStart } from '../../../src/durable-objects/task-runner/user-start-admission';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

describe('human conversation build-queue exemption', () => {
  it.each([
    ['user', 'conversation', false, true],
    ['connector', 'conversation', false, true],
    ['connector', 'conversation', true, false],
    ['connector', 'task', false, false],
    ['agent', 'conversation', false, false],
    ['schedule', 'conversation', false, false],
    ['user', 'task', false, false],
    ['user', 'conversation', true, false],
  ] as const)(
    'source=%s mode=%s recovery=%s',
    async (triggeredBy, taskMode, recovery, expected) => {
      const sqlite = new Database(':memory:');
      try {
        sqlite.exec(
          'CREATE TABLE tasks (id TEXT, project_id TEXT, user_id TEXT, task_mode TEXT, triggered_by TEXT)'
        );
        sqlite
          .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)')
          .run('task', 'project', 'user', taskMode, triggeredBy);
        const state = {
          taskId: 'task',
          projectId: 'project',
          userId: 'user',
          config: {
            taskMode,
            resumeSnapshotChatSessionId: recovery ? 'chat' : null,
          },
        } as TaskRunnerState;
        const rc = { env: { DATABASE: createSqliteD1(sqlite) } } as TaskRunnerContext;
        expect(await isUserConversationStart(state, rc)).toBe(expected);
        expect(await isUserConversationStart({ ...state, userId: 'foreign' }, rc)).toBe(false);
      } finally {
        sqlite.close();
      }
    }
  );
});
