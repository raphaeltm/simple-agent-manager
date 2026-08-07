import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleDeleteTrigger, handleUpdateTrigger } from '../../../src/routes/mcp/trigger-tools';

function createTestD1(sqlite: Database.Database): D1Database {
  const normalize = (params: unknown[]): unknown[] => params.map((p) => (p === undefined ? null : p));

  const makeBound = (sql: string, params: unknown[]) => ({
    async run() {
      const info = sqlite.prepare(sql).run(...normalize(params));
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        results: [],
      };
    },
    async all() {
      const results = sqlite.prepare(sql).all(...normalize(params));
      return { success: true, results, meta: {} };
    },
    async first(col?: string) {
      const row = sqlite.prepare(sql).get(...normalize(params)) as Record<string, unknown> | undefined;
      if (col != null) return row ? (row[col] ?? null) : null;
      return row ?? null;
    },
  });

  const makeStmt = (sql: string) => ({
    bind: (...params: unknown[]) => makeBound(sql, params),
    run: () => makeBound(sql, []).run(),
    all: () => makeBound(sql, []).all(),
    first: (col?: string) => makeBound(sql, []).first(col),
  });

  return {
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

interface TriggerRow {
  id: string;
  project_id: string;
  name: string;
  status: string;
  cron_expression: string | null;
  cron_timezone: string | null;
  next_fire_at: string | null;
  prompt_template: string;
}

function parseContent(response: Awaited<ReturnType<typeof handleUpdateTrigger>>): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  const content = response.result as { content: Array<{ text: string }> };
  return JSON.parse(content.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('MCP update_trigger and delete_trigger handlers', () => {
  let sqlite: Database.Database;
  let env: Env;
  let tokenData: McpTokenData;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE triggers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        source_type TEXT NOT NULL,
        cron_expression TEXT,
        cron_timezone TEXT,
        skip_if_running INTEGER NOT NULL DEFAULT 1,
        prompt_template TEXT NOT NULL,
        agent_profile_id TEXT,
        skill_id TEXT,
        task_mode TEXT,
        vm_size_override TEXT,
        max_concurrent INTEGER,
        next_fire_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE skills (id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE github_trigger_configs (id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, event_type TEXT NOT NULL, filters_json TEXT NOT NULL);
      CREATE TABLE trigger_executions (id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL);
    `);

    env = {
      DATABASE: createTestD1(sqlite),
      CRON_TEMPLATE_MAX_LENGTH: undefined,
      CRON_MIN_INTERVAL_MINUTES: undefined,
      TRIGGER_NAME_MAX_LENGTH: undefined,
      TRIGGER_MAX_CONCURRENT_LIMIT: undefined,
    } as Env;
    tokenData = {
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      createdAt: new Date().toISOString(),
    };
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertTrigger(id: string, projectId = tokenData.projectId): void {
    sqlite.prepare(
      `INSERT INTO triggers (
        id, project_id, user_id, name, description, status, source_type,
        cron_expression, cron_timezone, skip_if_running, prompt_template,
        agent_profile_id, skill_id, task_mode, vm_size_override, max_concurrent,
        next_fire_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'active', 'cron', '0 9 * * *', 'UTC', 1, ?, NULL, NULL, 'task', NULL, 1, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      projectId === tokenData.projectId ? tokenData.userId : 'other-user',
      `Trigger ${id}`,
      'Original prompt',
      '2000-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
  }

  it('updates a trigger and recomputes next_fire_at', async () => {
    insertTrigger('trigger-1');

    const response = await handleUpdateTrigger(
      'req-1',
      {
        triggerId: 'trigger-1',
        name: 'Updated trigger',
        cronExpression: '30 14 * * 1-5',
        cronTimezone: 'America/New_York',
        promptTemplate: 'Updated prompt',
        maxConcurrent: 2,
      },
      tokenData,
      env,
    );
    const payload = parseContent(response);
    const row = sqlite.prepare('SELECT * FROM triggers WHERE id = ?').get('trigger-1') as TriggerRow;

    expect(row.name).toBe('Updated trigger');
    expect(row.cron_expression).toBe('30 14 * * 1-5');
    expect(row.cron_timezone).toBe('America/New_York');
    expect(row.prompt_template).toBe('Updated prompt');
    expect(row.next_fire_at).toBeTruthy();
    expect(row.next_fire_at).not.toBe('2000-01-01T00:00:00.000Z');
    expect(payload.nextFireAt).toBe(row.next_fire_at);
    expect(payload.cronHumanReadable).toEqual(expect.any(String));
  });

  it('deletes a trigger and cascades GitHub config and executions', async () => {
    insertTrigger('trigger-2');
    sqlite.prepare(
      "INSERT INTO github_trigger_configs (id, trigger_id, event_type, filters_json) VALUES ('config-1', 'trigger-2', 'issues', '{}')",
    ).run();
    sqlite.prepare(
      "INSERT INTO trigger_executions (id, trigger_id, project_id, status) VALUES ('exec-1', 'trigger-2', 'project-1', 'running')",
    ).run();

    const response = await handleDeleteTrigger('req-1', { triggerId: 'trigger-2' }, tokenData, env);

    expect(response.error).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM github_trigger_configs WHERE trigger_id = 'trigger-2'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM trigger_executions WHERE trigger_id = 'trigger-2'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM triggers WHERE id = 'trigger-2'").get()).toEqual({ count: 0 });
  });

  it('rejects cross-project updates without mutating the trigger', async () => {
    insertTrigger('trigger-3', 'project-2');

    const response = await handleUpdateTrigger(
      'req-1',
      { triggerId: 'trigger-3', name: 'Unauthorized update' },
      tokenData,
      env,
    );
    const row = sqlite.prepare('SELECT * FROM triggers WHERE id = ?').get('trigger-3') as TriggerRow;

    expect(response.error?.message).toContain('Trigger not found in this project');
    expect(row.project_id).toBe('project-2');
    expect(row.name).toBe('Trigger trigger-3');
  });

  it('rejects cross-project deletes without mutating the trigger', async () => {
    insertTrigger('trigger-4', 'project-2');
    sqlite.prepare(
      "INSERT INTO trigger_executions (id, trigger_id, project_id, status) VALUES ('exec-4', 'trigger-4', 'project-2', 'running')",
    ).run();

    const response = await handleDeleteTrigger('req-1', { triggerId: 'trigger-4' }, tokenData, env);

    expect(response.error?.message).toContain('Trigger not found in this project');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM triggers WHERE id = 'trigger-4'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM trigger_executions WHERE trigger_id = 'trigger-4'").get()).toEqual({ count: 1 });
  });
});
