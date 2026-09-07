import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeProjectTool, PROJECT_AGENT_TOOLS } from '../../../src/durable-objects/project-agent/tools';
import { searchTasks, searchTasksDef } from '../../../src/durable-objects/sam-session/tools/search-tasks';
import type { ToolContext } from '../../../src/durable-objects/sam-session/types';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn().mockResolvedValue({
    credential: 'test-api-key',
  }),
}));

type SearchTaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  projectId: string;
  projectName: string;
  outputBranch: string | null;
  outputPrUrl: string | null;
  outputSummary: string | null;
  updatedAt: string;
};

function mockD1(rawResultSets: SearchTaskRow[][] = []) {
  const rawQueue = [...rawResultSets];
  const statement = {
    bind: vi.fn().mockReturnThis(),
    raw: vi.fn().mockImplementation(() => {
      const rows = rawQueue.shift() ?? [];
      return Promise.resolve(rows.map((row) => Object.values(row)));
    }),
    all: vi.fn().mockResolvedValue({ results: [], success: true }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };

  return {
    prepare: vi.fn().mockReturnValue(statement),
    _statement: statement,
  };
}

function buildCtx(options: {
  rows?: SearchTaskRow[];
  userId?: string;
  projectId?: string;
  snippetLength?: number;
} = {}): ToolContext & { _db: ReturnType<typeof mockD1> } {
  const db = mockD1([options.rows ?? []]);
  return {
    env: {
      DATABASE: db as unknown,
      MCP_TASK_DESCRIPTION_SNIPPET_LENGTH: String(options.snippetLength ?? 12),
    } as Record<string, unknown>,
    userId: options.userId ?? 'user-1',
    ...(options.projectId ? { projectId: options.projectId } : {}),
    _db: db,
  };
}

function bindArgs(ctx: ToolContext & { _db: ReturnType<typeof mockD1> }): unknown[] {
  return ctx._db._statement.bind.mock.calls.flat();
}

function preparedSql(ctx: ToolContext & { _db: ReturnType<typeof mockD1> }): string {
  return String(ctx._db.prepare.mock.calls[0]?.[0] ?? '');
}

const matchingRow: SearchTaskRow = {
  id: 'task-1',
  title: 'Investigate auth handoff',
  description: 'Description-only evidence about oauth callbacks and stale sessions.',
  status: 'in_progress',
  priority: 4,
  projectId: 'project-1',
  projectName: 'SAM',
  outputBranch: 'sam/auth-handoff',
  outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/123',
  outputSummary: 'Implemented search hardening and test coverage for task investigation flows.',
  updatedAt: '2026-06-27T12:34:56Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sam-session search_tasks contract', () => {
  it('advertises the canonical status vocabulary and query parameter', () => {
    const props = searchTasksDef.input_schema.properties as Record<string, { enum?: string[] }>;
    const statuses = props.status.enum ?? [];

    expect(searchTasksDef.input_schema.required).toContain('query');
    expect(props).toHaveProperty('query');
    expect(props).toHaveProperty('keyword');
    expect(statuses).toEqual([
      'draft',
      'queued',
      'in_progress',
      'delegated',
      'awaiting_followup',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(statuses).not.toContain('running');
  });

  it('rejects missing, blank, and one-character queries before querying D1', async () => {
    for (const input of [{}, { query: '   ' }, { query: 'a' }]) {
      const ctx = buildCtx();

      const result = await searchTasks(input, ctx);

      expect(result).toHaveProperty('error');
      expect(ctx._db.prepare).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid statuses and accepts in_progress', async () => {
    const invalidCtx = buildCtx();
    await expect(searchTasks({ query: 'auth', status: 'running' }, invalidCtx)).resolves.toEqual({
      error: 'status must be one of: draft, queued, in_progress, delegated, awaiting_followup, completed, failed, cancelled',
    });
    expect(invalidCtx._db.prepare).not.toHaveBeenCalled();

    const validCtx = buildCtx({ rows: [matchingRow] });
    const result = await searchTasks({ query: 'auth', status: 'in_progress' }, validCtx) as {
      tasks: Array<{ status: string }>;
    };

    expect(result.tasks[0]?.status).toBe('in_progress');
    expect(bindArgs(validCtx)).toContain('in_progress');
  });

  it('searches both task title and description with bound query parameters', async () => {
    const ctx = buildCtx({ rows: [matchingRow] });

    const result = await searchTasks({ query: 'oauth' }, ctx) as { count: number };

    expect(result.count).toBe(1);
    expect(preparedSql(ctx)).toContain('"tasks"."title" like ?');
    expect(preparedSql(ctx)).toContain('"tasks"."description" like ?');
    expect(bindArgs(ctx).filter((arg) => arg === '%oauth%')).toHaveLength(2);
  });

  it('rounds and clamps limits before passing them to D1', async () => {
    const lowCtx = buildCtx();
    await searchTasks({ query: 'auth', limit: -10 }, lowCtx);
    expect(bindArgs(lowCtx)).toContain(1);

    const highCtx = buildCtx();
    await searchTasks({ query: 'auth', limit: 100 }, highCtx);
    expect(bindArgs(highCtx)).toContain(20);

    const roundedCtx = buildCtx();
    await searchTasks({ query: 'auth', limit: 2.6 }, roundedCtx);
    expect(bindArgs(roundedCtx)).toContain(3);
  });

  it('returns canonical investigation fields with bounded snippets', async () => {
    const ctx = buildCtx({ rows: [matchingRow], snippetLength: 10 });

    const result = await searchTasks({ query: 'auth' }, ctx) as {
      tasks: Array<Record<string, unknown>>;
      count: number;
      query: string;
    };

    expect(result.query).toBe('auth');
    expect(result.count).toBe(1);
    expect(result.tasks[0]).toEqual({
      id: 'task-1',
      title: 'Investigate auth handoff',
      status: 'in_progress',
      priority: 4,
      projectId: 'project-1',
      projectName: 'SAM',
      descriptionSnippet: 'Descriptio...',
      outputBranch: 'sam/auth-handoff',
      outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/123',
      outputSummary: 'Implemente...',
      updatedAt: '2026-06-27T12:34:56Z',
    });
    expect(result.tasks[0]).not.toHaveProperty('description');
  });

  it('preserves user ownership and optional project scoping', async () => {
    const ctx = buildCtx({ userId: 'user-scope' });

    await searchTasks({ query: 'auth', projectId: 'project-scope' }, ctx);

    expect(preparedSql(ctx)).toContain('"projects"."user_id" = ?');
    expect(preparedSql(ctx)).toContain('"tasks"."project_id" = ?');
    expect(bindArgs(ctx)).toContain('user-scope');
    expect(bindArgs(ctx)).toContain('project-scope');
  });

  it('supports keyword as a deprecated alias for query', async () => {
    const ctx = buildCtx({ rows: [matchingRow] });

    const result = await searchTasks({ keyword: 'oauth' }, ctx) as { query: string; count: number };

    expect(result.query).toBe('oauth');
    expect(result.count).toBe(1);
    expect(bindArgs(ctx).filter((arg) => arg === '%oauth%')).toHaveLength(2);
  });
});

describe('project-agent search_tasks wrapper', () => {
  it('strips projectId and exposes the same canonical status vocabulary', () => {
    const def = PROJECT_AGENT_TOOLS.find((tool) => tool.name === 'search_tasks');
    expect(def).toBeDefined();

    const props = def?.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props).not.toHaveProperty('projectId');
    expect(props.status.enum).not.toContain('running');
    expect(props.status.enum).toContain('in_progress');
  });

  it('injects context projectId so callers cannot override project scope', async () => {
    const ctx = buildCtx({ projectId: 'ctx-project' });

    await executeProjectTool(
      {
        id: 'call-search',
        name: 'search_tasks',
        input: { query: 'auth', projectId: 'attacker-project' },
      },
      ctx,
    );

    expect(bindArgs(ctx)).toContain('ctx-project');
    expect(bindArgs(ctx)).not.toContain('attacker-project');
  });
});
