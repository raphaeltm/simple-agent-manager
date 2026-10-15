/**
 * Workspace agents' task discovery through the real MCP route and the real
 * `listTasks` SQL (in-memory SQLite; only KV is in memory).
 *
 * Before this test's change, `list_tasks` advertised a status enum without
 * `sleeping` (an agent could not ask for sleeping tasks), and it silently
 * returned at most one page with no way to tell a full page from a complete
 * answer (`.claude/rules/65`).
 */
import { TASK_STATUSES } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  callMcpTool,
  createJsonKv,
  createMcpApp,
  postMcp,
  storeMcpToken,
  toolResult,
} from '../helpers/mcp-route';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const PROJECT = 'project-1';
const MCP_TOKEN = 'agent-token';
const OWN_TASK = 'own-task';

interface TaskPage {
  tasks: Array<{ id: string; status: string }>;
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
}

describe('list_tasks and search_tasks for workspace agents', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.platformSettings, schema.tasks, schema.projects, schema.projectMembers]);
    // The shared operation authorizes the caller as an active project member.
    sqlite
      .prepare("INSERT INTO projects (id, name, user_id) VALUES (?, 'Project', 'user-1')")
      .run(PROJECT);
    sqlite
      .prepare(
        "INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, 'user-1', 'owner', 'active')"
      )
      .run(PROJECT);
    const kv = createJsonKv();
    await storeMcpToken(kv, MCP_TOKEN, {
      taskId: OWN_TASK,
      projectId: PROJECT,
      userId: 'user-1',
      workspaceId: 'ws-own',
    });
    env = { DATABASE: createSqliteD1(sqlite), KV: kv } as unknown as Env;
    app = await createMcpApp();
  });

  afterEach(() => sqlite.close());

  /** Rows are listed newest-updated first; `minute` orders them. */
  function insertTask(id: string, status: string, minute: number, title = `Task ${id}`): void {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority, created_at, updated_at)
         VALUES (?, ?, 'user-1', ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        PROJECT,
        title,
        `Description of ${id}`,
        status,
        new Date(Date.UTC(2026, 9, 11, 0, 0)).toISOString(),
        new Date(Date.UTC(2026, 9, 11, 0, minute)).toISOString()
      );
  }

  async function listTasks(args: Record<string, unknown>): Promise<TaskPage> {
    return toolResult<TaskPage>(await callMcpTool(app, env, MCP_TOKEN, 'list_tasks', args));
  }

  /** Follow nextCursor until hasMore is false; returns every page. */
  async function allPages(tool: 'list_tasks' | 'search_tasks', args: Record<string, unknown>) {
    const pages: TaskPage[] = [];
    let cursor: string | null = null;
    do {
      const response = await callMcpTool(app, env, MCP_TOKEN, tool, {
        ...args,
        ...(cursor ? { cursor } : {}),
      });
      const page = toolResult<TaskPage>(response);
      pages.push(page);
      cursor = page.nextCursor;
      expect(pages.length).toBeLessThan(10);
    } while (cursor);
    return pages;
  }

  it('advertises every task status, including sleeping, and a cursor argument', async () => {
    const body = await postMcp(app, env, MCP_TOKEN, 'tools/list');
    const tools = (
      body.result as {
        tools: Array<{
          name: string;
          inputSchema: { properties: Record<string, { enum?: string[] }> };
        }>;
      }
    ).tools;

    for (const name of ['list_tasks', 'search_tasks']) {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties;
      expect(properties?.status?.enum).toEqual([...TASK_STATUSES]);
      expect(properties?.status?.enum).toContain('sleeping');
      expect(properties?.cursor).toBeDefined();
    }
  });

  it('returns sleeping tasks when asked for them', async () => {
    insertTask('sleeping-1', 'sleeping', 1);
    insertTask('sleeping-2', 'sleeping', 2);
    insertTask('working', 'in_progress', 3);

    const page = await listTasks({ status: 'sleeping' });

    expect(page.tasks.map((task) => task.id)).toEqual(['sleeping-2', 'sleeping-1']);
    expect(page.hasMore).toBe(false);
  });

  it('discloses a full page and pages through every task exactly once', async () => {
    // Own task sits inside the first page's window: the page must still be full.
    insertTask('t1', 'completed', 1);
    insertTask('t2', 'completed', 2);
    insertTask('t3', 'completed', 3);
    insertTask(OWN_TASK, 'in_progress', 4);
    insertTask('t4', 'completed', 5);
    insertTask('t5', 'completed', 6);

    const pages = await allPages('list_tasks', { limit: 2 });

    expect(pages.map((page) => page.tasks.map((task) => task.id))).toEqual([
      ['t5', 't4'],
      ['t3', 't2'],
      ['t1'],
    ]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(pages[2]?.nextCursor).toBeNull();
  });

  it('reports more when the hidden own task is the only thing filling the page', async () => {
    // limit + 1 visible tasks with the own task among the newest rows.
    insertTask('t1', 'completed', 1);
    insertTask('t2', 'completed', 2);
    insertTask(OWN_TASK, 'in_progress', 3);
    insertTask('t3', 'completed', 4);

    const first = await listTasks({ limit: 2 });

    expect(first.tasks.map((task) => task.id)).toEqual(['t3', 't2']);
    expect(first.hasMore).toBe(true);
    expect((await listTasks({ limit: 2, cursor: first.nextCursor })).tasks).toEqual([
      expect.objectContaining({ id: 't1' }),
    ]);
  });

  it('pages include the own task when include_own is set', async () => {
    insertTask('t1', 'completed', 1);
    insertTask(OWN_TASK, 'in_progress', 2);
    insertTask('t2', 'completed', 3);

    const pages = await allPages('list_tasks', { limit: 2, include_own: true });

    expect(pages.flatMap((page) => page.tasks.map((task) => task.id))).toEqual([
      't2',
      OWN_TASK,
      't1',
    ]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, false]);
  });

  it('pages search results the same way', async () => {
    insertTask('match-1', 'completed', 1, 'Shepherd follow-up one');
    insertTask('other', 'completed', 2, 'Unrelated');
    insertTask('match-2', 'sleeping', 3, 'Shepherd follow-up two');

    const pages = await allPages('search_tasks', { query: 'Shepherd follow-up', limit: 1 });

    expect(pages.map((page) => page.tasks.map((task) => task.id))).toEqual([
      ['match-2'],
      ['match-1'],
    ]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, false]);
  });

  it('rejects a malformed cursor instead of returning an empty page', async () => {
    insertTask('t1', 'completed', 1);

    const response = await callMcpTool(app, env, MCP_TOKEN, 'list_tasks', {
      cursor: 'not-a-cursor',
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain('Invalid pagination cursor');
  });
});
