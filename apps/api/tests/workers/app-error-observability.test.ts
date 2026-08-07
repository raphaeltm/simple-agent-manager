import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { errors } from '../../src/middleware/error';
import { persistErrorBatch, queryErrors } from '../../src/services/observability';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function executionContext(pending: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;
}

function errorApp(errorFactory: () => Error): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.get('/api/projects/:projectId/tasks/:taskId/sessions/:sessionId/fail', () => {
    throw errorFactory();
  });
  app.get('/api/nodes/:id/fail', () => {
    throw errorFactory();
  });
  app.get('/api/workspaces/:id/fail', () => {
    throw errorFactory();
  });
  return app;
}

beforeEach(async () => {
  await env.OBSERVABILITY_DATABASE.prepare('DELETE FROM platform_errors').run();
});

describe('global app.onError observability persistence', () => {
  it('round-trips one requestId through the 5xx response and persisted row', async () => {
    const pending: Promise<unknown>[] = [];
    const app = errorApp(() => new Error('route exploded'));
    const response = await app.fetch(
      new Request(
        'https://api.test.example.com/api/projects/project-1/tasks/task-1/sessions/session-1/fail'
      ),
      env,
      executionContext(pending)
    );

    expect(response.status).toBe(500);
    const body = await response.json<{ requestId: string; message: string }>();
    expect(body.message).toBe('Internal server error');
    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);

    const row = await env.OBSERVABILITY_DATABASE.prepare(
      `SELECT source, level, task_id, session_id, context
       FROM platform_errors WHERE task_id = ?`
    )
      .bind('task-1')
      .first<{
        source: string;
        level: string;
        task_id: string;
        session_id: string;
        context: string;
      }>();
    expect(row).toMatchObject({
      source: 'api',
      level: 'error',
      task_id: 'task-1',
      session_id: 'session-1',
    });
    expect(JSON.parse(row!.context)).toEqual({
      requestId: body.requestId,
      path: '/api/projects/project-1/tasks/task-1/sessions/session-1/fail',
      method: 'GET',
      status: 500,
      taskId: 'task-1',
      sessionId: 'session-1',
      projectId: 'project-1',
    });
  });

  it('redacts secrets and bounds persisted message and stack lengths', async () => {
    const secret = `sk-ant-${'A'.repeat(24)}`;
    const pending: Promise<unknown>[] = [];
    const app = errorApp(() => {
      const error = new Error(`${secret}:${'m'.repeat(200)}`);
      error.stack = `${secret}:${'s'.repeat(300)}`;
      return error;
    });
    const bindings = {
      OBSERVABILITY_DATABASE: env.OBSERVABILITY_DATABASE,
      OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH: '32',
      OBSERVABILITY_ERROR_STACK_MAX_LENGTH: '48',
    } as Env;

    const response = await app.fetch(
      new Request(
        'https://api.test.example.com/api/projects/project-1/tasks/task-1/sessions/session-1/fail'
      ),
      bindings,
      executionContext(pending)
    );
    expect(response.status).toBe(500);
    await Promise.all(pending);

    const row = await env.OBSERVABILITY_DATABASE.prepare(
      'SELECT message, stack FROM platform_errors LIMIT 1'
    ).first<{ message: string; stack: string }>();
    expect(row!.message.length).toBeLessThanOrEqual(35);
    expect(row!.stack.length).toBeLessThanOrEqual(51);
    expect(row!.message).toContain('[REDACTED]');
    expect(row!.stack).toContain('[REDACTED]');
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('derives node and workspace correlation from conventional :id route params', async () => {
    const pending: Promise<unknown>[] = [];
    const app = errorApp(() => new Error('route exploded'));
    const [nodeResponse, workspaceResponse] = await Promise.all([
      app.fetch(
        new Request('https://api.test.example.com/api/nodes/node-1/fail'),
        env,
        executionContext(pending)
      ),
      app.fetch(
        new Request('https://api.test.example.com/api/workspaces/workspace-1/fail'),
        env,
        executionContext(pending)
      ),
    ]);
    expect(nodeResponse.status).toBe(500);
    expect(workspaceResponse.status).toBe(500);
    await Promise.all(pending);

    const rows = await env.OBSERVABILITY_DATABASE.prepare(
      'SELECT node_id, workspace_id FROM platform_errors ORDER BY node_id DESC'
    ).all<{ node_id: string | null; workspace_id: string | null }>();
    expect(rows.results).toEqual(
      expect.arrayContaining([
        { node_id: 'node-1', workspace_id: null },
        { node_id: null, workspace_id: 'workspace-1' },
      ])
    );
  });

  it('does not persist 4xx AppErrors or add a requestId to their response', async () => {
    const pending: Promise<unknown>[] = [];
    const app = errorApp(() => errors.badRequest('invalid request'));
    const response = await app.fetch(
      new Request(
        'https://api.test.example.com/api/projects/project-1/tasks/task-1/sessions/session-1/fail'
      ),
      env,
      executionContext(pending)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'BAD_REQUEST', message: 'invalid request' });
    expect(pending).toHaveLength(0);
    expect(
      await env.OBSERVABILITY_DATABASE.prepare(
        'SELECT COUNT(*) AS count FROM platform_errors'
      ).first('count')
    ).toBe(0);
  });

  it('returns the original 5xx response when observability persistence fails', async () => {
    const pending: Promise<unknown>[] = [];
    const app = errorApp(() => new Error('primary failure'));
    const brokenDatabase = {
      prepare() {
        throw new Error('observability unavailable');
      },
    } as unknown as D1Database;

    const response = await app.fetch(
      new Request(
        'https://api.test.example.com/api/projects/project-1/tasks/task-1/sessions/session-1/fail'
      ),
      { OBSERVABILITY_DATABASE: brokenDatabase } as Env,
      executionContext(pending)
    );

    expect(response.status).toBe(500);
    expect((await response.json<{ requestId: string }>()).requestId).toMatch(UUID_PATTERN);
    await expect(Promise.all(pending)).resolves.toHaveLength(1);
  });

  it('silently skips persistence when the observability binding is absent', async () => {
    const pending: Promise<unknown>[] = [];
    const app = errorApp(() => new Error('primary failure'));
    const response = await app.fetch(
      new Request(
        'https://api.test.example.com/api/projects/project-1/tasks/task-1/sessions/session-1/fail'
      ),
      {} as Env,
      executionContext(pending)
    );
    expect(response.status).toBe(500);
    expect(pending).toHaveLength(0);
  });
});

describe('real observability migration chain', () => {
  it('adds correlation columns and every required exact-match index', async () => {
    const columns = await env.OBSERVABILITY_DATABASE.prepare(
      'PRAGMA table_info(platform_errors)'
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(['task_id', 'session_id'])
    );

    const indexes = await env.OBSERVABILITY_DATABASE.prepare(
      'PRAGMA index_list(platform_errors)'
    ).all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'idx_platform_errors_task_id',
        'idx_platform_errors_session_id',
        'idx_platform_errors_node_id',
        'idx_platform_errors_workspace_id',
      ])
    );
  });

  it('queries every new correlation filter by exact match and returns task/session IDs', async () => {
    const timestamp = Date.UTC(2026, 7, 7, 1, 0, 0);
    await persistErrorBatch(env.OBSERVABILITY_DATABASE, [
      {
        id: 'target-error',
        source: 'api',
        message: 'target',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        userId: 'user-1',
        timestamp,
      },
      {
        id: 'suffix-error',
        source: 'api',
        message: 'suffix',
        nodeId: 'node-10',
        workspaceId: 'workspace-10',
        taskId: 'task-10',
        sessionId: 'session-10',
        userId: 'user-10',
        timestamp: timestamp + 1,
      },
    ]);

    const filters = [
      { nodeId: 'node-1' },
      { workspaceId: 'workspace-1' },
      { taskId: 'task-1' },
      { sessionId: 'session-1' },
      { userId: 'user-1' },
      { endTime: timestamp },
    ];
    for (const filter of filters) {
      const result = await queryErrors(env.OBSERVABILITY_DATABASE, filter);
      expect(result.errors.map((error) => error.id)).toEqual(['target-error']);
      expect(result.errors[0]).toMatchObject({ taskId: 'task-1', sessionId: 'session-1' });
    }
  });
});
