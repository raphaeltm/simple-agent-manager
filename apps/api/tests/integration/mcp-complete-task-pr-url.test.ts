import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import type { McpTokenData } from '../../src/routes/mcp/_helpers';
import { handleCompleteTask } from '../../src/routes/mcp/task-tools';
import { cleanupTerminalTaskResources } from '../../src/services/task-terminal-cleanup';
import { runTaskTerminalTransitionHooks } from '../../src/services/task-terminal-transition-hooks';
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
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.projects, schema.tasks, schema.pullRequests]);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_pull_requests_project_repo_number ON pull_requests(project_id, repository, number)'
    );
    sqlite
      .prepare(
        "INSERT INTO projects (id, repository) VALUES ('project-1', 'raphaeltm/simple-agent-manager')"
      )
      .run();
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
    expect(
      sqlite.prepare('SELECT project_id, repository, number FROM pull_requests').get()
    ).toEqual({
      project_id: 'project-1',
      repository: 'raphaeltm/simple-agent-manager',
      number: 9999,
    });
  });

  it('still runs terminal hooks and cleanup when PR storage fails after completion', async () => {
    const d1 = createSqliteD1(sqlite);
    const env = {
      DATABASE: {
        prepare: (sql: string) => {
          if (sql.includes('INSERT OR IGNORE INTO pull_requests')) {
            throw new Error('PR storage unavailable');
          }
          return d1.prepare(sql);
        },
      },
      PROJECT_DATA: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response('{}')) })),
      },
      NOTIFICATION: null,
    } as unknown as Env;
    const waits: Promise<unknown>[] = [];
    const response = await handleCompleteTask(
      2,
      {
        summary: 'Shipped',
        evidence: { prUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/9999' },
      },
      {
        taskId: 'task-1',
        projectId: 'project-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: new Date().toISOString(),
      },
      env,
      { waitUntil: (promise) => waits.push(promise) }
    );
    await Promise.all(waits);
    expect(response.error).toBeUndefined();
    expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get()).toEqual({
      status: 'completed',
    });
    expect(waits).toHaveLength(1);
    expect(runTaskTerminalTransitionHooks).toHaveBeenCalled();
    expect(cleanupTerminalTaskResources).toHaveBeenCalled();
  });
});
