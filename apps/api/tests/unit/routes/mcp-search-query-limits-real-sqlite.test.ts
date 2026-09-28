import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleSearchIdeas } from '../../../src/routes/mcp/idea-tools';
import { handleSearchTasks } from '../../../src/routes/mcp/task-tools';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const SEARCH_TERMS = Array.from({ length: 20 }, (_, index) => `needle${index}`);
const LONG_QUERY = SEARCH_TERMS.join(' ');
const PREFIX_ONLY_TEXT = SEARCH_TERMS.slice(0, 10).join(' ');
const ALL_TERMS_TEXT = SEARCH_TERMS.join(' ');

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
      'Prefix-only idea control',
      PREFIX_ONLY_TEXT,
      'draft',
      2,
      '2026-01-04T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z'
    );
    insert.run(
      'idea-match',
      tokenData.projectId,
      tokenData.userId,
      'Late-term idea match',
      ALL_TERMS_TEXT,
      'draft',
      2,
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z'
    );
    insert.run(
      'task-control',
      tokenData.projectId,
      tokenData.userId,
      'Prefix-only task control',
      PREFIX_ONLY_TEXT,
      'completed',
      1,
      '2026-01-05T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z'
    );
    insert.run(
      'task-match',
      tokenData.projectId,
      tokenData.userId,
      'Late-term task match',
      ALL_TERMS_TEXT,
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

  it('search_ideas searches late terms in a long query and excludes prefix-only controls', async () => {
    const response = await handleSearchIdeas(1, { query: LONG_QUERY }, tokenData, env);
    const body = parseToolResult(response);

    expect((body.ideas as Array<{ ideaId: string }>).map((idea) => idea.ideaId)).toEqual([
      'idea-match',
    ]);
    expect(body.queryTruncated).toBe(false);
    expect(body.query).toBe(LONG_QUERY);
  });

  it('search_tasks searches late terms in a long query and excludes prefix-only controls', async () => {
    const response = await handleSearchTasks(
      2,
      { query: LONG_QUERY, status: 'completed' },
      tokenData,
      env
    );
    const body = parseToolResult(response);

    expect((body.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual([
      'task-match',
    ]);
    expect(body.queryTruncated).toBe(false);
    expect(body.query).toBe(LONG_QUERY);
  });

  it('keeps normal short-query ordering and results unchanged', async () => {
    const response = await handleSearchTasks(3, { query: 'needle0' }, tokenData, env);
    const body = parseToolResult(response);

    expect((body.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual([
      'task-control',
      'idea-new',
      'task-match',
      'idea-match',
      'task-old',
    ]);
    expect(body.queryTruncated).toBe(false);
    expect(body.query).toBe('needle0');
  });
});
