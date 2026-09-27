import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import type { McpTokenData } from '../../src/routes/mcp/_helpers';
import { handleCompleteTask } from '../../src/routes/mcp/task-tools';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/task-terminal-transition-hooks', () => ({
  createProjectEventTaskTerminalTransitionHook: vi.fn(() => vi.fn()),
  createTaskWaitTerminalTransitionHook: vi.fn(() => vi.fn()),
  runTaskTerminalTransitionHooks: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: vi.fn(async () => undefined),
}));

describe('complete_task PR URL persistence', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.tasks]);
    sqlite
      .prepare(
        `INSERT INTO tasks
         (id, project_id, user_id, title, status, task_mode)
         VALUES ('task-1', 'project-1', 'user-1', 'Ship fix', 'in_progress', 'task')`
      )
      .run();
  });

  afterEach(() => sqlite.close());

  it('persists evidence.prUrl to tasks.output_pr_url through the MCP handler', async () => {
    const env = {
      DATABASE: createSqliteD1(sqlite),
      PROJECT_DATA: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response('{}')) })),
      },
      NOTIFICATION: null,
    } as unknown as Env;
    const tokenData = {
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      createdAt: new Date().toISOString(),
    } satisfies McpTokenData;
    const prUrl = 'https://github.com/raphaeltm/simple-agent-manager/pull/9999';

    const response = await handleCompleteTask(
      1,
      { summary: 'Shipped', evidence: { prUrl } },
      tokenData,
      env
    );

    expect(response.error).toBeUndefined();
    expect(
      sqlite
        .prepare('SELECT status, output_pr_url, completion_evidence FROM tasks WHERE id = ?')
        .get('task-1')
    ).toEqual({
      status: 'completed',
      output_pr_url: prUrl,
      completion_evidence: JSON.stringify({ prUrl }),
    });
  });
});
