/**
 * Unit tests for MCP create_trigger tool.
 *
 * Tests input validation and successful creation flow.
 * Uses direct D1 mock since the handler uses raw SQL (not Drizzle ORM).
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { INVALID_PARAMS, type McpTokenData } from '../../../src/routes/mcp/_helpers';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockValidateCron = vi
  .fn()
  .mockReturnValue({ valid: true, humanReadable: 'Every day at 9:00 AM' });
vi.mock('../../../src/services/cron-utils', () => ({
  validateCronExpression: (...args: unknown[]) => mockValidateCron(...args),
  cronToNextFire: vi.fn().mockReturnValue('2026-04-10T09:00:00.000Z'),
  cronToHumanReadable: vi.fn().mockReturnValue('Every day at 9:00 AM (UTC)'),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'trigger-001',
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── D1 mock ────────────────────────────────────────────────────────────────

function createMockD1() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    _stmt: stmt,
  };
}

function createSqliteD1(sqlite: Database.Database): D1Database {
  const normalize = (params: unknown[]): unknown[] =>
    params.map((p) => (p === undefined ? null : p));

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
      const row = sqlite.prepare(sql).get(...normalize(params)) as
        | Record<string, unknown>
        | undefined;
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

// ─── Test setup ─────────────────────────────────────────────────────────────

import { handleCreateTrigger } from '../../../src/routes/mcp/trigger-tools';

const tokenData: McpTokenData = {
  taskId: 'task-001',
  projectId: 'proj-001',
  userId: 'user-001',
  workspaceId: 'ws-001',
  createdAt: new Date().toISOString(),
};

function createSqliteTriggerEnv(): { sqlite: Database.Database; env: Env } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, max_triggers INTEGER);
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
      resource_requirements_json TEXT,
      max_concurrent INTEGER,
      next_fire_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, project_id TEXT);
  `);
  sqlite
    .prepare('INSERT INTO projects (id, max_triggers) VALUES (?, NULL)')
    .run(tokenData.projectId);

  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1(sqlite),
      CRON_TEMPLATE_MAX_LENGTH: undefined,
      MAX_TRIGGERS_PER_PROJECT: undefined,
      CRON_MIN_INTERVAL_MINUTES: undefined,
      TRIGGER_NAME_MAX_LENGTH: undefined,
    } as Env,
  };
}

function insertExistingTrigger(
  sqlite: Database.Database,
  resourceRequirementsJson = '{"minVcpu":2,"exclusiveNode":false}'
): void {
  sqlite
    .prepare(
      `INSERT INTO triggers (
        id, project_id, user_id, name, description, status, source_type,
        cron_expression, cron_timezone, skip_if_running, prompt_template,
        agent_profile_id, skill_id, task_mode, vm_size_override, resource_requirements_json,
        max_concurrent, next_fire_at, created_at, updated_at
      ) VALUES ('existing-trigger', ?, ?, 'Existing trigger', NULL, 'active', 'cron',
        '0 9 * * *', 'UTC', 1, 'Existing prompt', NULL, NULL, 'task', NULL, ?,
        1, '2000-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z')`
    )
    .run(tokenData.projectId, tokenData.userId, resourceRequirementsJson);
}

const invalidModernResourceRequirementValues: Array<[string, unknown]> = [
  ['empty string', ''],
  ['whitespace string', '   '],
  ['JSON object string', '{"minVcpu":2}'],
  ['array', [{ minVcpu: 2 }]],
  ['number', 2],
];

describe('MCP create_trigger tool', () => {
  let mockD1: ReturnType<typeof createMockD1>;
  let env: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    env = {
      DATABASE: mockD1 as unknown as D1Database,
      CRON_TEMPLATE_MAX_LENGTH: undefined,
      MAX_TRIGGERS_PER_PROJECT: undefined,
      CRON_MIN_INTERVAL_MINUTES: undefined,
    } as Partial<Env>;
  });

  it('creates a trigger successfully with required fields', async () => {
    // Name uniqueness check: no existing trigger
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Project lookup: no per-project max_triggers override
    mockD1._stmt.first.mockResolvedValueOnce({ maxTriggers: null });
    // Count check: below limit
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Daily Review',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Review all open PRs',
      },
      tokenData,
      env as Env
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    const content = (result.result as { content: { text: string }[] }).content[0];
    const parsed = JSON.parse(content.text);
    expect(parsed.triggerId).toBe('trigger-001');
    expect(parsed.name).toBe('Daily Review');
    expect(parsed.status).toBe('active');
    expect(parsed.cronExpression).toBe('0 9 * * *');
    expect(parsed.cronHumanReadable).toBeDefined();
    expect(parsed.nextFireAt).toBeDefined();
  });

  it('rejects missing name', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      { cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('name is required');
  });

  it('rejects empty cron expression', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('cronExpression is required');
  });

  it('rejects empty prompt template', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: '   ' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('promptTemplate is required');
  });

  it('rejects prompt template exceeding max length', async () => {
    const longTemplate = 'x'.repeat(8001); // Default max is 8000
    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: longTemplate },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('characters or less');
  });

  it('rejects invalid cron expression', async () => {
    mockValidateCron.mockReturnValueOnce({ valid: false, error: 'bad expression' });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: 'not-valid', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Invalid cron expression');
  });

  it('rejects invalid timezone', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Test',
        cronExpression: '0 9 * * *',
        cronTimezone: 'Invalid/Zone',
        promptTemplate: 'Do stuff',
      },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Invalid timezone');
  });

  it('rejects agentProfileId not in project', async () => {
    // agentProfileId lookup: not found
    mockD1._stmt.first.mockResolvedValueOnce(null);

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Test',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Do stuff',
        agentProfileId: 'nonexistent-profile',
      },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('agentProfileId not found');
  });

  it('rejects duplicate trigger name', async () => {
    // Name uniqueness check: existing trigger found
    mockD1._stmt.first.mockResolvedValueOnce({ id: 'existing-trigger' });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Daily Review', cronExpression: '0 9 * * *', promptTemplate: 'Review PRs' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('already exists');
  });

  it('rejects when max triggers reached', async () => {
    // Name uniqueness: no conflict
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Project lookup: no override (default 20)
    mockD1._stmt.first.mockResolvedValueOnce({ maxTriggers: null });
    // Count check: at limit (default 20)
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 20 });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Maximum triggers per project');
  });

  it('uses the per-project max_triggers override when set', async () => {
    // Name uniqueness: no conflict
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Project lookup: per-project override of 5 (below the default 20)
    mockD1._stmt.first.mockResolvedValueOnce({ maxTriggers: 5 });
    // Count check: at the per-project limit
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 5 });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Maximum triggers per project');
  });

  it('uses the per-project max_triggers override to allow more than the default', async () => {
    // Name uniqueness: no conflict
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Project lookup: per-project override raised to 30
    mockD1._stmt.first.mockResolvedValueOnce({ maxTriggers: 30 });
    // Count check: 25 triggers (above default 20, below override 30) → allowed
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 25 });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it('uses default UTC timezone when not specified', async () => {
    mockD1._stmt.first.mockResolvedValueOnce(null);
    mockD1._stmt.first.mockResolvedValueOnce({ maxTriggers: null });
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env
    );

    expect(result.error).toBeUndefined();
    const content = (result.result as { content: { text: string }[] }).content[0];
    const parsed = JSON.parse(content.text);
    expect(parsed.cronTimezone).toBe('UTC');
  });

  it('accepts optional fields (agentProfileId, taskMode, vmSizeOverride, resourceRequirements)', async () => {
    // agentProfileId lookup: found
    mockD1._stmt.first.mockResolvedValueOnce({ id: 'profile-1' });
    // Name uniqueness: no conflict
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Project lookup: no override
    mockD1._stmt.first.mockResolvedValueOnce({ maxTriggers: null });
    // Count check: below limit
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Full Config',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Do stuff',
        agentProfileId: 'profile-1',
        taskMode: 'conversation',
        vmSizeOverride: 'large',
        resourceRequirements: { minVcpu: 4, exclusiveNode: false, maxCoTenants: 2 },
      },
      tokenData,
      env as Env
    );

    expect(result.error).toBeUndefined();
    const content = (result.result as { content: { text: string }[] }).content[0];
    const parsed = JSON.parse(content.text);
    expect(parsed.taskMode).toBe('conversation');
    expect(parsed.vmSizeOverride).toBe('large');
    expect(parsed.resourceRequirementsJson).toBe(
      '{"minVcpu":4,"exclusiveNode":false,"maxCoTenants":2}'
    );
  });

  it('rejects invalid vmSizeOverride values', async () => {
    mockD1._stmt.first.mockResolvedValueOnce(null);
    mockD1._stmt.first.mockResolvedValueOnce({ maxTriggers: null });
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Test',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Do stuff',
        vmSizeOverride: 'xlarge',
      },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('vmSizeOverride must be');
  });

  it('rejects malformed resourceRequirements', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Test',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Do stuff',
        resourceRequirements: { minMemoryGb: -1 },
      },
      tokenData,
      env as Env
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('finite positive number');
  });

  it.each(invalidModernResourceRequirementValues)(
    'rejects modern resourceRequirements %s before mutating trigger rows',
    async (_label, resourceRequirements) => {
      const { sqlite, env: sqliteEnv } = createSqliteTriggerEnv();
      try {
        insertExistingTrigger(sqlite);

        const result = await handleCreateTrigger(
          'req-1',
          {
            name: 'Invalid modern resources',
            cronExpression: '0 9 * * *',
            promptTemplate: 'Do stuff',
            resourceRequirements,
            resourceRequirementsJson: '{"minVcpu":8}',
          },
          tokenData,
          sqliteEnv
        );

        expect(result.error?.code).toBe(INVALID_PARAMS);
        expect(result.error?.message).toContain('resourceRequirements must be a JSON object');
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM triggers').get()).toEqual({
          count: 1,
        });
        expect(
          sqlite
            .prepare(
              "SELECT name, resource_requirements_json FROM triggers WHERE id = 'existing-trigger'"
            )
            .get()
        ).toEqual({
          name: 'Existing trigger',
          resource_requirements_json: '{"minVcpu":2,"exclusiveNode":false}',
        });
      } finally {
        sqlite.close();
      }
    }
  );

  it('accepts compatibility JSON strings through resourceRequirementsJson', async () => {
    const { sqlite, env: sqliteEnv } = createSqliteTriggerEnv();
    try {
      const result = await handleCreateTrigger(
        'req-1',
        {
          name: 'Legacy resources',
          cronExpression: '0 9 * * *',
          promptTemplate: 'Do stuff',
          resourceRequirementsJson: '{"minVcpu":2,"exclusiveNode":false}',
        },
        tokenData,
        sqliteEnv
      );

      expect(result.error).toBeUndefined();
      expect(
        sqlite
          .prepare("SELECT resource_requirements_json FROM triggers WHERE id = 'trigger-001'")
          .get()
      ).toEqual({
        resource_requirements_json: '{"minVcpu":2,"exclusiveNode":false}',
      });
    } finally {
      sqlite.close();
    }
  });
});
