import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleSearchIdeas } from '../../../src/routes/mcp/idea-tools';
import { handleSearchTasks } from '../../../src/routes/mcp/task-tools';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const SAFE_PREFIX = Array.from({ length: 6 }, (_, index) => `needle${index}`).join(' ');
const OVER_LIMIT_QUERY = `${SAFE_PREFIX} ${'overflow '.repeat(8_000)}`;

const tokenData = {
  projectId: 'project-1',
  userId: 'user-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
} as McpTokenData;

function parseToolResult(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('MCP task-backed search query limits with real SQLite', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.tasks]);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;

    const insert = sqlite.prepare(
      `INSERT INTO tasks
         (id, project_id, user_id, title, description, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      'idea-new',
      tokenData.projectId,
      tokenData.userId,
      'Newest bounded idea',
      SAFE_PREFIX,
      'draft',
      2,
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z'
    );
    insert.run(
      'task-new',
      tokenData.projectId,
      tokenData.userId,
      'Newest bounded task',
      SAFE_PREFIX,
      'completed',
      1,
      '2026-01-03T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z'
    );
    insert.run(
      'task-old',
      tokenData.projectId,
      tokenData.userId,
      'Older bounded task',
      'needle0 control text',
      'completed',
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
  });

  afterEach(() => sqlite.close());

  it('search_ideas truncates a SQLite-invalid long query and returns a match', async () => {
    const response = await handleSearchIdeas(1, { query: OVER_LIMIT_QUERY }, tokenData, env);
    const body = parseToolResult(response);

    expect((body.ideas as Array<{ ideaId: string }>).map((idea) => idea.ideaId)).toEqual([
      'idea-new',
    ]);
    expect(body.queryTruncated).toBe(true);
    expect(body.query).toBe(SAFE_PREFIX);
  });

  it('search_tasks truncates a SQLite-invalid long query and returns a match', async () => {
    const response = await handleSearchTasks(
      2,
      { query: OVER_LIMIT_QUERY, status: 'completed' },
      tokenData,
      env
    );
    const body = parseToolResult(response);

    expect((body.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual([
      'task-new',
    ]);
    expect(body.queryTruncated).toBe(true);
    expect(body.query).toBe(SAFE_PREFIX);
  });

  it('keeps normal short-query ordering and results unchanged', async () => {
    const response = await handleSearchTasks(3, { query: 'needle0' }, tokenData, env);
    const body = parseToolResult(response);

    expect((body.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual([
      'task-new',
      'idea-new',
      'task-old',
    ]);
    expect(body.queryTruncated).toBe(false);
    expect(body.query).toBe('needle0');
  });
});
